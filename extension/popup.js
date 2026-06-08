const HISTORY_KEY = "history"; // matches background.js

async function renderTunnels() {
  const o = await chrome.storage.session.get("tunnels");
  const m = o.tunnels || {};
  const list = document.getElementById("list");
  list.textContent = "";

  const tabIds = Object.keys(m);
  if (tabIds.length === 0) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "No active tunnels. Type  pf host:port  in the address bar.";
    list.appendChild(d);
    return;
  }

  for (const tabId of tabIds) {
    const info = m[tabId];
    const row = document.createElement("div");
    row.className = "row";

    const a = document.createElement("a");
    a.href = "#";
    a.title = "Focus tab (localhost:" + info.localPort + ")";
    a.textContent = info.host + ":" + info.remotePort + "  (localhost:" + info.localPort + ")";
    a.addEventListener("click", async function (e) {
      e.preventDefault();
      try { await chrome.tabs.update(Number(tabId), { active: true }); } catch (_) {}
      window.close();
    });

    const btn = document.createElement("button");
    btn.textContent = "Close";
    btn.title = "Close the tab and tear down the tunnel";
    btn.addEventListener("click", async function () {
      await chrome.runtime.sendMessage({ type: "closeTunnel", tabId: Number(tabId) });
      renderTunnels();
    });

    row.appendChild(a);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

async function renderHistoryButton() {
  const o = await chrome.storage.local.get(HISTORY_KEY);
  const n = (o[HISTORY_KEY] || []).length;
  const btn = document.getElementById("clear-history");
  btn.textContent = n ? "Clear history (" + n + ")" : "No history";
  btn.disabled = n === 0;
}

document.getElementById("clear-history").addEventListener("click", async function () {
  await chrome.storage.local.remove(HISTORY_KEY);
  renderHistoryButton();
});

renderTunnels();
renderHistoryButton();
