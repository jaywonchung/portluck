// Portluck background service worker.
// Bridges the omnibox and tab lifecycle to a native messaging host that runs ssh.
//
// Lifecycle reasoning (Manifest V3):
//   The native host process lives only as long as our messaging port is open.
//   When the service worker is suspended, Chrome closes the port and the host
//   exits, taking its ssh tunnels with it. So while any tunnel is active we keep
//   the worker awake (an open native port plus a periodic ping). When the last
//   tunnel goes away we let everything wind down so idle Chrome stays clean.
//   Because a fresh worker always implies a fresh host with no tunnels, we
//   reconcile our stored tab->tunnel map against the host's real list on connect.

const HOST = "com.portluck.host";
const KEEPALIVE_ALARM = "portluck-keepalive";
const KEEPALIVE_MS = 20000;
const START_TIMEOUT_MS = 25000;

let nativePort = null;
const pendingStarts = new Map();
let keepAliveScheduled = false;

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
function setMap(m) {
  return chrome.storage.session.set({ tunnels: m });
}
async function addTunnel(tabId, info) {
  const m = await getMap();
  m[String(tabId)] = info;
  await setMap(m);
}
async function removeTunnel(tabId) {
  const m = await getMap();
  if (m[String(tabId)]) {
    delete m[String(tabId)];
    await setMap(m);
  }
}
function clearTunnelMap() {
  return setMap({});
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

function getPort() {
  if (nativePort) return nativePort;
  const p = chrome.runtime.connectNative(HOST);
  nativePort = p;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(onDisconnect);
  // Ask the host what it currently holds so we can drop stale map entries.
  try { p.postMessage({ cmd: "list" }); } catch (e) { /* surfaces via onDisconnect */ }
  return p;
}

function onDisconnect() {
  const err = chrome.runtime.lastError;
  log("host disconnected", err && err.message);
  nativePort = null;
  const reason = err && err.message ? "native host: " + err.message : "native host disconnected";
  for (const entry of pendingStarts.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pendingStarts.clear();
  // Host gone means its tunnels are gone, so any tab we track is now dead.
  clearTunnelMap();
}

function onHostMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "started") {
    const pend = pendingStarts.get(msg.id);
    if (pend) { clearTimeout(pend.timer); pendingStarts.delete(msg.id); pend.resolve(msg); }
  } else if (msg.type === "error") {
    const pend = pendingStarts.get(msg.id);
    if (pend) { clearTimeout(pend.timer); pendingStarts.delete(msg.id); pend.reject(new Error(msg.message || "tunnel failed")); }
    else notify("Portluck error", msg.message || "tunnel error");
  } else if (msg.type === "exited") {
    handleExited(msg);
  } else if (msg.type === "list") {
    reconcileToIds(new Set(msg.ids || []));
  }
}

function startTunnel(parsed) {
  const id = crypto.randomUUID();
  const port = getPort();
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      pendingStarts.delete(id);
      reject(new Error("timed out starting tunnel"));
    }, START_TIMEOUT_MS);
    pendingStarts.set(id, { resolve: resolve, reject: reject, timer: timer });
    try {
      port.postMessage({ cmd: "start", id: id, host: parsed.host, remotePort: parsed.remotePort, localPort: parsed.localPort });
    } catch (e) {
      clearTimeout(timer);
      pendingStarts.delete(id);
      reject(e);
    }
  }).then(function (started) {
    return { id: id, localPort: started.localPort };
  });
}

function stopTunnel(id) {
  if (!id) return;
  try { getPort().postMessage({ cmd: "stop", id: id }); } catch (e) { log("stop failed", e); }
}

async function getActiveTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs && tabs[0] ? tabs[0].id : null;
  } catch (e) {
    return null;
  }
}

async function openTunnel(parsed, disposition) {
  // The tab the user typed "pf ..." into, captured before any await. On a plain
  // Enter (disposition "currentTab") Chrome expects us to navigate this tab, not
  // spawn a second one, so we reuse it as the tunnel's tab.
  const triggerTabId = await getActiveTabId();
  const useTrigger = disposition === "currentTab" && triggerTabId != null;

  const m = await getMap();
  // If a live tab already forwards this host:port, just focus it.
  for (const tabIdStr of Object.keys(m)) {
    const info = m[tabIdStr];
    if (info.host === parsed.host && info.remotePort === parsed.remotePort) {
      const tabId = Number(tabIdStr);
      try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        // The trigger tab was about to be consumed by this navigation anyway, so
        // drop it rather than leaving it stranded next to the focused tunnel tab.
        if (useTrigger && triggerTabId !== tabId) {
          try { await chrome.tabs.remove(triggerTabId); } catch (e) {}
        }
        return;
      } catch (e) {
        stopTunnel(info.id);
        await removeTunnel(tabId);
      }
    }
  }
  try {
    const started = await startTunnel(parsed);
    const url = "http://localhost:" + started.localPort + "/";
    let tabId;
    if (useTrigger) {
      try {
        await chrome.tabs.update(triggerTabId, { url: url });
        tabId = triggerTabId;
      } catch (e) {
        // Trigger tab vanished while ssh was connecting; open a fresh one.
        tabId = (await chrome.tabs.create({ url: url })).id;
      }
    } else {
      tabId = (await chrome.tabs.create({ url: url, active: disposition !== "newBackgroundTab" })).id;
    }
    await addTunnel(tabId, {
      id: started.id,
      host: parsed.host,
      remotePort: parsed.remotePort,
      localPort: started.localPort
    });
    ensureKeepAlive();
    log("up", parsed.host + ":" + parsed.remotePort, "on localhost:" + started.localPort, "tab", tabId);
  } catch (e) {
    notify("Portluck: could not forward " + parsed.host + ":" + parsed.remotePort, String((e && e.message) || e));
    log("start failed", e);
  }
}

async function handleExited(msg) {
  const m = await getMap();
  for (const tabIdStr of Object.keys(m)) {
    if (m[tabIdStr].id === msg.id) {
      const info = m[tabIdStr];
      await removeTunnel(Number(tabIdStr));
      notify("Portluck: tunnel closed", info.host + ":" + info.remotePort + (msg.message ? " (" + msg.message + ")" : ""));
      break;
    }
  }
}

async function reconcileToIds(ids) {
  const m = await getMap();
  let changed = false;
  for (const tabIdStr of Object.keys(m)) {
    if (!ids.has(m[tabIdStr].id)) { delete m[tabIdStr]; changed = true; }
  }
  if (changed) await setMap(m);
}

async function reconcileTabs() {
  const m = await getMap();
  let changed = false;
  for (const tabIdStr of Object.keys(m)) {
    try {
      await chrome.tabs.get(Number(tabIdStr));
    } catch (e) {
      stopTunnel(m[tabIdStr].id);
      delete m[tabIdStr];
      changed = true;
    }
  }
  if (changed) await setMap(m);
}

function ensureKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  scheduleKeepAlive();
}
function scheduleKeepAlive() {
  if (keepAliveScheduled) return;
  keepAliveScheduled = true;
  setTimeout(tickKeepAlive, KEEPALIVE_MS);
}
async function tickKeepAlive() {
  keepAliveScheduled = false;
  const m = await getMap();
  if (Object.keys(m).length === 0) {
    chrome.alarms.clear(KEEPALIVE_ALARM);
    if (nativePort) { try { nativePort.disconnect(); } catch (e) {} nativePort = null; }
    return;
  }
  try { getPort().postMessage({ cmd: "ping" }); } catch (e) {}
  scheduleKeepAlive();
}

async function boot() {
  const m = await getMap();
  if (Object.keys(m).length > 0) {
    getPort();          // reconciles our map against the host's real list
    ensureKeepAlive();
  }
}

chrome.omnibox.setDefaultSuggestion({
  description: "Forward a remote port over SSH: type host:port (for example somenode:8888)"
});

chrome.omnibox.onInputChanged.addListener(function (text, suggest) {
  const parsed = parseInput(text);
  if (parsed) {
    const lp = parsed.localPort || parsed.remotePort;
    chrome.omnibox.setDefaultSuggestion({
      description: "Forward " + xml(parsed.host) + ":" + parsed.remotePort + " to localhost:" + lp + " over SSH, then open it"
    });
  } else {
    chrome.omnibox.setDefaultSuggestion({
      description: "Type host:port  (for example somenode:8888, or somenode:8888:9000 to choose the local port)"
    });
  }
  buildHistorySuggestions(text).then(suggest);
});

chrome.omnibox.onDeleteSuggestion.addListener(function (content) {
  removeFromHistory(content);
});

chrome.omnibox.onInputEntered.addListener(function (text, disposition) {
  const parsed = parseInput(text);
  if (!parsed) {
    notify("Portluck", "Could not parse \"" + text + "\". Use host:port, for example somenode:8888.");
    return;
  }
  recordHistory(canonical(parsed));
  openTunnel(parsed, disposition);
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
  const m = await getMap();
  const info = m[String(tabId)];
  if (!info) return;
  stopTunnel(info.id);
  await removeTunnel(tabId);
  log("tab", tabId, "closed; stopped", info.host + ":" + info.remotePort);
});

chrome.alarms.onAlarm.addListener(async function (a) {
  if (a.name !== KEEPALIVE_ALARM) return;
  const m = await getMap();
  if (Object.keys(m).length === 0) {
    chrome.alarms.clear(KEEPALIVE_ALARM);
    if (nativePort) { try { nativePort.disconnect(); } catch (e) {} nativePort = null; }
    return;
  }
  getPort();
  scheduleKeepAlive();
  await reconcileTabs();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "closeTunnel") {
    (async function () {
      const m = await getMap();
      const info = m[String(msg.tabId)];
      if (info) { stopTunnel(info.id); await removeTunnel(msg.tabId); }
      try { await chrome.tabs.remove(msg.tabId); } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(function () { boot(); });
chrome.runtime.onStartup.addListener(function () { boot(); });

boot();
