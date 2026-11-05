// Tab records outlive individual SSH attempts and remain until their tabs close.
const HOST = "com.portluck.host";
const KEEPALIVE_ALARM = "portluck-keepalive";
const RETRY_ALARM = "portluck-retry";
const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 300000;
// Leave time for the native host's 30-second deadline and process cleanup.
const START_TIMEOUT_MS = 35000;
const STOP_TIMEOUT_MS = 5000;
let connection = null;
let stateQueue = Promise.resolve();
const attemptTimers = new Map();

// Serialize storage changes without holding this queue while SSH connects.
function enqueue(action) {
  const result = stateQueue.then(action);
  stateQueue = result.catch(function (error) { log(error); });
  return result;
}
function dispatch(action) {
  enqueue(action).catch(function (error) { notify("Portluck error", error.message || String(error)); });
}

function log() {
  console.log.apply(console, ["[portluck]"].concat(Array.prototype.slice.call(arguments)));
}

function notify(title, message) {
  chrome.notifications.create("", {
    type: "basic",
    iconUrl: "icon128.png",
    title: title,
    message: message
  }, function () { void chrome.runtime.lastError; });
}

function xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseInput(text) {
  if (!text) return null;
  // [user@]host:remotePort[:localPort]   host may be an alias or a dotted FQDN.
  const m = text.trim().match(/^((?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+):(\d{1,5})(?::(\d{1,5}))?$/);
  if (!m) return null;
  const remotePort = parseInt(m[2], 10);
  const localPort = m[3] ? parseInt(m[3], 10) : null;
  if (remotePort < 1 || remotePort > 65535) return null;
  if (localPort !== null && (localPort < 1 || localPort > 65535)) return null;
  return { host: m[1], remotePort: remotePort, localPort: localPort };
}


function getMap() {
  return chrome.storage.session.get("tunnels").then(function (o) { return o.tunnels || {}; });
}
async function saveMap(map) {
  await chrome.storage.session.set({ tunnels: map });
  const entries = Object.values(map);
  if (entries.length) {
    if (!await chrome.alarms.get(KEEPALIVE_ALARM)) {
      await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    }
  } else {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
  }
  const next = entries.filter(function (info) { return info.nextRetryAt; })
    .map(function (info) { return info.nextRetryAt; });
  if (next.length) {
    await chrome.alarms.create(RETRY_ALARM, { when: Math.min.apply(null, next) });
  } else {
    await chrome.alarms.clear(RETRY_ALARM);
  }
  if (!entries.length && !attemptTimers.size && connection) connection.port.disconnect();
}

const HISTORY_KEY = "history";
const HISTORY_MAX = 50;

// Canonical host:port[:localPort] string, used both as a history entry and as the
// content of an omnibox suggestion (so selecting one replays exactly this input).
function canonical(parsed) {
  return parsed.localPort
    ? parsed.host + ":" + parsed.remotePort + ":" + parsed.localPort
    : parsed.host + ":" + parsed.remotePort;
}

function getHistory() {
  return chrome.storage.local.get(HISTORY_KEY).then(function (o) { return o[HISTORY_KEY] || []; });
}
async function recordHistory(entry) {
  const h = await getHistory();
  const next = [entry].concat(h.filter(function (e) { return e !== entry; }));
  if (next.length > HISTORY_MAX) next.length = HISTORY_MAX;
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}
async function removeFromHistory(entry) {
  const h = await getHistory();
  await chrome.storage.local.set({ [HISTORY_KEY]: h.filter(function (e) { return e !== entry; }) });
}

// Most-recent-first history filtered by what has been typed so far: prefix matches
// first, then substring matches, never echoing an exact match of the current text.
async function buildHistorySuggestions(text) {
  const q = (text || "").trim().toLowerCase();
  const h = await getHistory();
  let entries = h;
  if (q) {
    const starts = h.filter(function (e) { return e.toLowerCase().startsWith(q); });
    const contains = h.filter(function (e) {
      const le = e.toLowerCase();
      return !le.startsWith(q) && le.includes(q);
    });
    entries = starts.concat(contains);
  }
  entries = entries.filter(function (e) { return e.toLowerCase() !== q; });
  return entries.slice(0, 8).map(function (e) {
    return { content: e, description: xml(e) + "  <dim>forward over SSH</dim>", deletable: true };
  });
}

function clearAttemptTimer(id) {
  if (attemptTimers.has(id)) clearTimeout(attemptTimers.get(id));
  attemptTimers.delete(id);
}

function fail(info, message, retryable) {
  clearAttemptTimer(info.id);
  info.id = null;
  info.status = retryable ? "disconnected" : "error";
  info.lastError = message;
  info.restartRequested = false;
  if (retryable) {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(info.retryCount, 4)));
    info.retryCount += 1;
    info.nextRetryAt = Date.now() + delay;
  } else {
    info.nextRetryAt = null;
  }
}

async function getConnection() {
  if (connection) return connection.ready;
  const port = chrome.runtime.connectNative(HOST);
  const current = { port: port, ready: null, reject: null, handshakeTimer: null };
  connection = current;
  current.ready = new Promise(function (resolve, reject) {
    current.reject = reject;
    current.handshakeTimer = setTimeout(function () {
      reject(new Error("Native host did not respond. Rebuild it with scripts/install.sh, then reload Portluck."));
      port.disconnect();
    }, 3000);
    port.onMessage.addListener(function (msg) {
      if (connection !== current) return;
      if (msg.type === "ready") {
        clearTimeout(current.handshakeTimer);
        if (msg.protocol !== 2) {
          reject(new Error("Native host version mismatch. Run scripts/install.sh, then reload Portluck."));
          port.disconnect();
        } else {
          resolve(current);
        }
      } else {
        dispatch(function () { return onHostMessage(current, msg); });
      }
    });
    port.onDisconnect.addListener(function () {
      const error = chrome.runtime.lastError;
      const message = error ? error.message : "Native host disconnected";
      clearTimeout(current.handshakeTimer);
      reject(new Error(message));
      dispatch(async function () {
        if (connection !== current) return;
        connection = null;
        const map = await getMap();
        for (const [key, info] of Object.entries(map)) {
          if (info.id) {
            if (info.replacement) map[key] = newRecord(info.replacement);
            fail(map[key], message, true);
          }
        }
        for (const id of attemptTimers.keys()) clearAttemptTimer(id);
        await saveMap(map);
      });
    });
  });
  return current.ready;
}

async function begin(map, tabId) {
  const info = map[String(tabId)];
  if (!info || info.id) return;
  try { await chrome.tabs.get(tabId); }
  catch (_) { delete map[String(tabId)]; return; }
  info.status = "checking";
  info.nextRetryAt = null;
  info.lastError = "";
  await saveMap(map);
  try {
    const current = await getConnection();
    // The tab can close while the native host handshake is pending.
    try { await chrome.tabs.get(tabId); }
    catch (_) { delete map[String(tabId)]; return; }
    const id = crypto.randomUUID();
    info.id = id;
    current.port.postMessage({
      cmd: "start", id: id, host: info.host, remotePort: info.remotePort,
      localPort: info.localPort, strictLocalPort: info.hasConnected
    });
    attemptTimers.set(id, setTimeout(function () {
      dispatch(async function () {
        const latest = await getMap();
        const record = latest[String(tabId)];
        if (record && record.id === id && ["checking", "connecting"].includes(record.status)) {
          record.lastError = "SSH startup timed out. Check network or VPN.";
          await stopAttempt(record, false);
          await saveMap(latest);
        }
      });
    }, START_TIMEOUT_MS));
  } catch (error) {
    fail(info, error.message || String(error), false);
    notify("Portluck could not connect", info.lastError);
  }
}

async function stopAttempt(info, restart) {
  info.restartRequested = restart;
  info.nextRetryAt = null;
  if (!info.id) return;
  const id = info.id;
  clearAttemptTimer(id);
  info.status = "stopping";
  if (!connection) {
    fail(info, "Native host disconnected", true);
    return;
  }
  const current = connection;
  try { current.port.postMessage({ cmd: "stop", id: id }); }
  catch (_) { current.port.disconnect(); return; }
  attemptTimers.set(id, setTimeout(function () {
    // Closing the messaging port stops all host-owned processes if cancellation stalls.
    if (connection === current) current.port.disconnect();
  }, STOP_TIMEOUT_MS));
}

async function reconnect(tabId, reload) {
  const map = await getMap();
  const info = map[String(tabId)];
  if (!info) throw new Error("This tab has no Portluck tunnel");
  info.reloadAfterConnect = info.reloadAfterConnect || reload;
  if (["checking", "connecting", "stopping"].includes(info.status)) {
    await saveMap(map);
    return;
  }
  info.retryCount = 0;
  if (info.id) await stopAttempt(info, true);
  else await begin(map, tabId);
  await saveMap(map);
}

async function onHostMessage(current, msg) {
  if (connection !== current || !msg || !msg.id) return;
  const map = await getMap();
  const entry = Object.entries(map).find(function (entry) { return entry[1].id === msg.id; });
  if (!entry) {
    if (msg.type === "started") current.port.postMessage({ cmd: "stop", id: msg.id });
    if (["stopped", "error", "exited"].includes(msg.type)) clearAttemptTimer(msg.id);
    if (!Object.keys(map).length && !attemptTimers.size) current.port.disconnect();
    return;
  }
  const tabId = Number(entry[0]);
  const info = entry[1];
  if (info.status === "stopping" && ["started", "progress"].includes(msg.type)) return;
  if (msg.type === "progress") {
    if (!["checking", "connecting"].includes(msg.status)) throw new Error("Invalid native tunnel status");
    info.status = msg.status;
  } else if (msg.type === "started") {
    if (!Number.isInteger(msg.localPort) || msg.localPort < 1 || msg.localPort > 65535
        || (info.hasConnected && info.localPort !== msg.localPort)) {
      info.lastError = "Native host returned an incorrect local port";
      await stopAttempt(info, false);
    } else {
      clearAttemptTimer(msg.id);
      const initial = !info.hasConnected;
      info.localPort = msg.localPort;
      info.hasConnected = true;
      info.status = "connected";
      info.retryCount = 0;
      info.nextRetryAt = null;
      info.lastError = "";
      try {
        await chrome.tabs.get(tabId);
        if (initial) await chrome.tabs.update(tabId, { url: "http://localhost:" + info.localPort + "/" });
        else if (info.reloadAfterConnect) await chrome.tabs.reload(tabId);
        info.reloadAfterConnect = false;
      } catch (_) {
        await stopAttempt(info, false);
        delete map[String(tabId)];
      }
    }
  } else if (["error", "exited", "stopped"].includes(msg.type)) {
    const restart = info.restartRequested;
    const replacement = info.replacement;
    const reason = msg.message || info.lastError || "SSH connection closed";
    if (msg.type === "error" && !info.hasConnected && info.retryCount === 0) {
      notify("Portluck could not forward " + info.host + ":" + info.remotePort, reason);
    }
    fail(info, reason, msg.type !== "error" || msg.retryable === true);
    if (replacement) {
      map[String(tabId)] = newRecord(replacement);
      await begin(map, tabId);
    } else if (restart) await begin(map, tabId);
  }
  await saveMap(map);
}

async function closeTunnel(tabId, closeTab) {
  const map = await getMap();
  const info = map[String(tabId)];
  if (info) {
    await stopAttempt(info, false);
    delete map[String(tabId)];
    await saveMap(map);
  }
  if (closeTab) await chrome.tabs.remove(tabId);
}

async function maintain() {
  const map = await getMap();
  for (const [key, info] of Object.entries(map)) {
    const tabId = Number(key);
    try { await chrome.tabs.get(tabId); }
    catch (_) {
      await stopAttempt(info, false);
      delete map[key];
      continue;
    }
    if (!info.id && info.nextRetryAt && info.nextRetryAt <= Date.now()) await begin(map, tabId);
  }
  if (connection) {
    try { connection.port.postMessage({ cmd: "ping" }); }
    catch (_) { connection.port.disconnect(); }
  }
  await saveMap(map);
  if (!Object.keys(map).length && !attemptTimers.size && connection) connection.port.disconnect();
}

async function boot() {
  const map = await getMap();
  for (const [key, stored] of Object.entries(map)) {
    const info = stored.replacement ? newRecord(stored.replacement) : stored;
    map[key] = info;
    if (stored.replacement) fail(info, "SSH connection interrupted", true);
    info.hasConnected = info.hasConnected === undefined ? Boolean(info.localPort) : info.hasConnected;
    info.retryCount = Number.isInteger(info.retryCount) ? info.retryCount : 0;
    if (info.id || ["checking", "connecting", "stopping"].includes(info.status) || !info.status) {
      fail(info, "SSH connection interrupted", true);
    }
  }
  await saveMap(map);
  await maintain();
}

async function openTunnel(parsed, disposition) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const triggerTabId = tabs[0] && tabs[0].id;
  const useTrigger = disposition === "currentTab" && triggerTabId != null;
  const map = await getMap();
  for (const [key, info] of Object.entries(map)) {
    if (info.host !== parsed.host || info.remotePort !== parsed.remotePort
        || (parsed.localPort !== null && info.localPort !== parsed.localPort)) continue;
    const tabId = Number(key);
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch (_) {
      await stopAttempt(info, false);
      delete map[key];
      continue;
    }
    await saveMap(map);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    if (useTrigger && triggerTabId !== tabId) await chrome.tabs.remove(triggerTabId);
    if (info.status !== "connected") await reconnect(tabId, false);
    return;
  }
  const tabId = useTrigger ? triggerTabId
    : (await chrome.tabs.create({ active: disposition !== "newBackgroundTab" })).id;
  const previous = map[String(tabId)];
  if (previous && previous.id) {
    previous.replacement = parsed;
    await stopAttempt(previous, true);
  } else {
    map[String(tabId)] = newRecord(parsed);
    await begin(map, tabId);
  }
  await saveMap(map);
}

function newRecord(parsed) {
  return {
    id: null, host: parsed.host, remotePort: parsed.remotePort, localPort: parsed.localPort,
    hasConnected: false, status: "disconnected", retryCount: 0, nextRetryAt: null,
    lastError: "", reloadAfterConnect: false, restartRequested: false
  };
}

chrome.omnibox.setDefaultSuggestion({
  description: "Forward a remote port over SSH: type host:port (for example somenode:8888)"
});
chrome.omnibox.onInputChanged.addListener(function (text, suggest) {
  const parsed = parseInput(text);
  chrome.omnibox.setDefaultSuggestion({ description: parsed
    ? "Forward " + xml(parsed.host) + ":" + parsed.remotePort + " over SSH"
    : "Type host:port, or host:remotePort:localPort" });
  buildHistorySuggestions(text).then(suggest).catch(function (e) { log(e); });
});
chrome.omnibox.onDeleteSuggestion.addListener(function (content) {
  dispatch(function () { return removeFromHistory(content); });
});
chrome.omnibox.onInputEntered.addListener(function (text, disposition) {
  const parsed = parseInput(text);
  if (!parsed) { notify("Portluck", "Use host:port or host:remotePort:localPort."); return; }
  dispatch(async function () {
    await recordHistory(canonical(parsed));
    await openTunnel(parsed, disposition);
  });
});
chrome.tabs.onRemoved.addListener(function (tabId) {
  dispatch(function () { return closeTunnel(tabId, false); });
});
chrome.alarms.onAlarm.addListener(function (alarm) {
  if ([KEEPALIVE_ALARM, RETRY_ALARM].includes(alarm.name)) dispatch(maintain);
});
chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || !["closeTunnel", "reconnectTunnel"].includes(msg.type)) return;
  if (!Number.isInteger(msg.tabId)) { respond({ ok: false, error: "Invalid tab" }); return; }
  enqueue(function () {
    return msg.type === "closeTunnel" ? closeTunnel(msg.tabId, true) : reconnect(msg.tabId, msg.reload === true);
  }).then(function () { respond({ ok: true }); }, function (error) { respond({ ok: false, error: error.message }); });
  return true;
});
dispatch(boot);
