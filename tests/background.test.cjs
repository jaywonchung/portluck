const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { return listeners.map(fn => fn(...args)); } };
}

async function harness(initial = {}) {
  const storage = { tunnels: structuredClone(initial) };
  const local = {};
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'about:blank', active: true }]]);
  const ports = [];
  const timers = new Map();
  const alarms = new Map();
  const reloads = [];
  const notices = [];
  let now = 1000000;
  let timerId = 0;
  let tabId = 1;
  const area = data => ({
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; }
  });
  const chrome = {
    storage: { session: area(storage), local: area(local) },
    notifications: { create(id, value, cb) { notices.push(value); cb(); } },
    runtime: {
      lastError: null, onMessage: event(),
      connectNative() {
        const port = {
          onMessage: event(), onDisconnect: event(), sent: [], disconnected: false,
          postMessage(message) {
            if (this.disconnected) throw new Error('Port disconnected');
            this.sent.push(structuredClone(message));
          },
          disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }
        };
        ports.push(port);
        queueMicrotask(() => port.onMessage.emit({ type: 'ready', protocol: 2 }));
        return port;
      }
    },
    tabs: {
      onRemoved: event(),
      async query() { return [...tabs.values()].filter(tab => tab.active); },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return structuredClone(tabs.get(id)); },
      async update(id, props) {
        if (!tabs.has(id)) throw new Error('No tab');
        if (props.active) for (const tab of tabs.values()) tab.active = false;
        Object.assign(tabs.get(id), props);
        return structuredClone(tabs.get(id));
      },
      async create(props) { const tab = { id: ++tabId, windowId: 1, url: 'about:blank', ...props }; tabs.set(tab.id, tab); return structuredClone(tab); },
      async remove(id) { if (!tabs.delete(id)) throw new Error('No tab'); this.onRemoved.emit(id); },
      async reload(id) { await this.get(id); reloads.push(id); }
    },
    windows: { async update() {} },
    alarms: {
      onAlarm: event(), async get(name) { return alarms.get(name); },
      async create(name, value) { alarms.set(name, structuredClone(value)); },
      async clear(name) { alarms.delete(name); }
    },
    omnibox: { setDefaultSuggestion() {}, onInputChanged: event(), onInputEntered: event(), onDeleteSuggestion: event() }
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ chrome, crypto: { randomUUID }, console, Date: Clock,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  async function drain() {
    for (let i = 0; i < 8; i++) { await vm.runInContext('stateQueue', context); await Promise.resolve(); }
  }
  await drain();
  return {
    chrome, tabs, ports, storage, alarms, reloads, notices, timers, drain,
    get record() { return storage.tunnels['1']; },
    get port() { return ports.at(-1); },
    starts() { return ports.flatMap(port => port.sent.filter(msg => msg.cmd === 'start')); },
    async open(input = 'server:8888', disposition = 'currentTab') { chrome.omnibox.onInputEntered.emit(input, disposition); await drain(); },
    async emit(message, port = ports.at(-1)) { port.onMessage.emit(message); await drain(); },
    async started(port = 8888) { const id = storage.tunnels['1'].id; await this.emit({ type: 'started', id, localPort: port }); },
    async request(type, reload = false, id = 1) {
      const response = new Promise(resolve => chrome.runtime.onMessage.emit({ type, tabId: id, reload }, {}, resolve));
      await drain();
      const result = await response;
      assert.equal(result.ok, true, result.error);
    },
    async retry() {
      const next = Math.min(...Object.values(storage.tunnels).map(info => info.nextRetryAt || Infinity));
      now = next;
      chrome.alarms.onAlarm.emit({ name: 'portluck-retry' });
      await drain();
    },
    async timeout(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `No ${ms}ms timer`);
      timers.delete(entry[0]); entry[1].fn(); await drain();
    }
  };
}

test('exit preserves owner, exact local port, URL and page state through retries', async () => {
  const h = await harness();
  await h.open(); await h.started(9000);
  h.tabs.get(1).url = 'http://localhost:9000/notebook?q=1#cell';
  const id = h.record.id;
  await h.emit({ type: 'exited', id, message: 'Connection lost' });
  assert.equal(h.record.status, 'disconnected');
  assert.equal(h.record.localPort, 9000);
  await h.retry();
  const retry = h.starts().at(-1);
  assert.equal(retry.localPort, 9000); assert.equal(retry.strictLocalPort, true);
  await h.started(9000);
  assert.equal(h.tabs.size, 1);
  assert.equal(h.tabs.get(1).url, 'http://localhost:9000/notebook?q=1#cell');
  assert.deepEqual(h.reloads, []);
});

test('manual reconnect waits for stop acknowledgement and deduplicates clicks', async () => {
  const h = await harness(); await h.open(); await h.started();
  const id = h.record.id;
  await h.request('reconnectTunnel'); await h.request('reconnectTunnel');
  assert.equal(h.starts().length, 1);
  await h.emit({ type: 'stopped', id });
  assert.equal(h.starts().length, 2);
  await h.request('reconnectTunnel');
  assert.equal(h.starts().length, 2);
});

test('closing during startup cancels and rejects late success', async () => {
  const h = await harness(); await h.open();
  const id = h.record.id;
  await h.request('closeTunnel');
  assert.equal(h.record, undefined); assert.equal(h.tabs.size, 0);
  assert.ok(h.port.sent.some(msg => msg.cmd === 'stop' && msg.id === id));
  await h.emit({ type: 'started', id, localPort: 8888 });
  assert.equal(h.record, undefined);
  await h.emit({ type: 'stopped', id });
  assert.equal(h.port.disconnected, true);
});

test('host loss retains records and recreates native connection', async () => {
  const h = await harness(); await h.open(); await h.started();
  h.port.disconnect(); await h.drain();
  assert.equal(h.record.status, 'disconnected');
  await h.retry();
  assert.equal(h.ports.length, 2);
  assert.equal(h.starts().at(-1).strictLocalPort, true);
});

test('authentication errors stop automatic retry but allow manual retry', async () => {
  const h = await harness(); await h.open();
  await h.emit({ type: 'error', id: h.record.id, message: 'Permission denied', retryable: false });
  assert.equal(h.record.status, 'error'); assert.equal(h.record.nextRetryAt, null);
  await h.request('reconnectTunnel'); assert.equal(h.starts().length, 2);
});

test('retry delay increases and is capped', async () => {
  const h = await harness(); await h.open();
  const delays = [];
  let now = 1000000;
  for (let i = 0; i < 6; i++) {
    await h.emit({ type: 'error', id: h.record.id, message: 'Check VPN', retryable: true });
    delays.push(h.record.nextRetryAt - now);
    now = h.record.nextRetryAt;
    await h.retry();
  }
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 300000, 300000]);
});

test('startup watchdog cancels before retry and ignores old messages', async () => {
  const h = await harness(); await h.open(); const old = h.record.id;
  await h.timeout(35000);
  assert.equal(h.record.status, 'stopping'); assert.equal(h.record.nextRetryAt, null);
  assert.ok(h.port.sent.some(msg => msg.cmd === 'stop' && msg.id === old));
  await h.emit({ type: 'stopped', id: old }); await h.retry();
  const current = h.record.id;
  await h.emit({ type: 'error', id: old, message: 'late', retryable: false });
  assert.equal(h.record.id, current); assert.equal(h.record.status, 'checking');
});

test('stalled cancellation disconnects the native host', async () => {
  const h = await harness(); await h.open(); await h.started();
  await h.request('reconnectTunnel'); await h.timeout(5000);
  assert.equal(h.port.disconnected, true); assert.equal(h.record.status, 'disconnected');
});

test('worker restart retains association for a surviving tab', async () => {
  const h = await harness(); await h.open(); await h.started(9000);
  const resumed = await harness(h.storage.tunnels);
  assert.equal(resumed.record.status, 'disconnected');
  await resumed.retry();
  assert.equal(resumed.starts()[0].localPort, 9000);
});

test('repeating pf reconnects and focuses the existing tab', async () => {
  const h = await harness(); await h.open(); await h.started();
  await h.emit({ type: 'exited', id: h.record.id });
  await h.open();
  assert.equal(h.tabs.size, 1); assert.equal(h.starts().length, 2);
});

test('reload happens only when explicitly requested, after success', async () => {
  const h = await harness(); await h.open(); await h.started();
  const id = h.record.id;
  await h.request('reconnectTunnel', true);
  assert.deepEqual(h.reloads, []);
  await h.emit({ type: 'stopped', id }); await h.started();
  assert.deepEqual(h.reloads, [1]);
  await h.emit({ type: 'exited', id: h.record.id }); await h.retry(); await h.started();
  assert.deepEqual(h.reloads, [1]);
});

test('separate tabs keep separate records under concurrent events', async () => {
  const h = await harness(); await h.open(); await h.open('second:9000', 'newBackgroundTab');
  assert.equal(Object.keys(h.storage.tunnels).length, 2);
  for (const start of h.starts()) h.port.onMessage.emit({ type: 'error', id: start.id, message: 'offline', retryable: true });
  await h.drain();
  assert.equal(Object.values(h.storage.tunnels).filter(info => info.status === 'disconnected').length, 2);
});

test('changing destination in a tab stops the previous attempt first', async () => {
  const h = await harness(); await h.open(); await h.started();
  const id = h.record.id;
  await h.open('second:9000');
  assert.equal(h.starts().length, 1);
  await h.emit({ type: 'stopped', id });
  assert.equal(h.starts().at(-1).host, 'second');
  assert.equal(h.tabs.size, 1);
});

test('a queued startup timer cannot cancel an already connected tunnel', async () => {
  const h = await harness(); await h.open();
  const timer = [...h.timers.values()].find(timer => timer.ms === 35000);
  await h.started();
  timer.fn(); await h.drain();
  assert.equal(h.record.status, 'connected');
  assert.equal(h.port.sent.filter(message => message.cmd === 'stop').length, 0);
});

test('host loss during destination replacement retains the newly requested destination', async () => {
  const h = await harness(); await h.open(); await h.started();
  await h.open('second:9000'); h.port.disconnect(); await h.drain(); await h.retry();
  assert.equal(h.starts().at(-1).host, 'second');
});
