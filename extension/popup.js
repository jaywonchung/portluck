async function render() {
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
      render();
    });

    row.appendChild(a);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

render();
