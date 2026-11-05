const HISTORY_KEY = "history";
let renderVersion = 0;

async function request(type, tabId, reload) {
  const response = await chrome.runtime.sendMessage({ type: type, tabId: tabId, reload: reload });
  if (!response || !response.ok) throw new Error(response ? response.error : "Portluck did not respond");
}

async function renderTunnels() {
  const version = ++renderVersion;
  const stored = await chrome.storage.session.get("tunnels");
  if (version !== renderVersion) return;
  const entries = Object.entries(stored.tunnels || {});
  const list = document.getElementById("list");
  list.textContent = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tunnels. Type pf host:port in the address bar.";
    list.appendChild(empty);
  }
  for (const [key, info] of entries) {
    const tabId = Number(key);
    const row = document.createElement("div");
    row.className = "row";
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = info.host + ":" + info.remotePort
      + (info.localPort ? " (localhost:" + info.localPort + ")" : "");
    link.title = "Focus the owning tab";
    link.addEventListener("click", async function (event) {
      event.preventDefault();
      try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        window.close();
      } catch (error) { showError(error.message); }
    });
    const status = document.createElement("div");
    status.className = "status";
    const labels = { connected: "Connected", checking: "Checking server reachability...",
      connecting: "Connecting...", stopping: "Stopping SSH...", disconnected: "Disconnected", error: "Needs attention" };
    status.textContent = labels[info.status] || "Unknown connection status";
    if (info.nextRetryAt) status.textContent += ". Retry at " + new Date(info.nextRetryAt).toLocaleTimeString();
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = info.lastError || "";
    const controls = document.createElement("div");
    controls.className = "controls";
    const busy = ["checking", "connecting", "stopping"].includes(info.status);
    for (const [label, type, reload] of [
      ["Reconnect", "reconnectTunnel", false],
      ["Reconnect and reload", "reconnectTunnel", true],
      ["Close", "closeTunnel", false]
    ]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.disabled = busy && type !== "closeTunnel";
      button.title = type === "closeTunnel" ? "Close the owning tab and cancel its tunnel"
        : reload ? "Reconnect, then reload the owning tab. Unsaved page changes may be lost."
        : "Reconnect without reloading the owning tab";
      button.addEventListener("click", async function () {
        button.disabled = true;
        try {
          await request(type, tabId, reload);
          await renderTunnels();
        } catch (failure) { showError(failure.message); button.disabled = false; }
      });
      controls.appendChild(button);
    }
    row.append(link, status, error, controls);
    list.appendChild(row);
  }
}

function showError(message) {
  document.getElementById("popup-error").textContent = message;
}

async function renderHistoryButton() {
  const o = await chrome.storage.local.get(HISTORY_KEY);
  const n = (o[HISTORY_KEY] || []).length;
  const btn = document.getElementById("clear-history");
  btn.textContent = n ? "Clear history (" + n + ")" : "No history";
  btn.disabled = n === 0;
}

document.getElementById("clear-history").addEventListener("click", async function () {
  try {
    await chrome.storage.local.remove(HISTORY_KEY);
    await renderHistoryButton();
  } catch (error) { showError(error.message); }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "session" && changes.tunnels) renderTunnels().catch(function (e) { showError(e.message); });
  if (area === "local" && changes.history) renderHistoryButton().catch(function (e) { showError(e.message); });
});
renderTunnels().catch(function (e) { showError(e.message); });
renderHistoryButton().catch(function (e) { showError(e.message); });
