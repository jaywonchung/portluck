const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const binary = path.resolve('native-host/target/debug/portluck-host');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, banner = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portluck-native-tests-'));
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    if (banner) socket.write('SSH-2.0-test\r\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.copyFileSync('tests/fixtures/ssh.cjs', path.join(dir, 'ssh'));
  fs.chmodSync(path.join(dir, 'ssh'), 0o755);
  const log = path.join(dir, 'events.jsonl'); fs.writeFileSync(log, '');
  const proxy = path.join(dir, 'proxy.cjs');
  fs.writeFileSync(proxy, "process.stdout.write('SSH-2.0-proxy\\r\\n'); process.stdin.resume();");
  const child = spawn(binary, [], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
    PORTLUCK_TEST_PORT: String(server.address().port), PORTLUCK_TEST_LOG: log, PORTLUCK_TEST_PROXY: proxy },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const messages = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      messages.push(JSON.parse(buffer.subarray(4, length + 4).toString()));
      buffer = buffer.subarray(length + 4);
    }
  });
  async function receive(type, id, deadline = 7000) {
    const started = Date.now();
    while (Date.now() - started < deadline) {
      const index = messages.findIndex(msg => msg.type === type && (id === undefined || msg.id === id));
      if (index !== -1) return messages.splice(index, 1)[0];
      if (child.exitCode !== null) throw new Error(`Native host exited ${child.exitCode}: ${stderr}`);
      await pause(10);
    }
    throw new Error(`No ${type} for ${id}: ${JSON.stringify(messages)} ${stderr}`);
  }
  function send(value) {
    const body = Buffer.from(JSON.stringify(value));
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([prefix, body]));
  }
  function events() { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true });
  });
  await receive('ready');
  return { child, send, receive, events, messages,
    start(id, host = 'server', local = null) {
      send({ cmd: 'start', id, host, remotePort: 8888, localPort: local, strictLocalPort: local !== null });
    }
  };
}

async function assertGone(pids) {
  for (let i = 0; i < 100; i++) {
    const live = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch (e) { assert.equal(e.code, 'ESRCH'); return false; } });
    if (!live.length) return;
    await pause(10);
  }
  assert.fail('An SSH process or descendant survived cancellation');
}

test('native startup, fixed-port restart, and cancellation stop process groups', async t => {
  const f = await fixture(t); f.start('one');
  const first = await f.receive('started', 'one');
  const socket = net.connect(first.localPort, '127.0.0.1');
  const [data] = await once(socket, 'data'); assert.equal(data.toString(), 'forwarded'); socket.destroy();
  f.send({ cmd: 'stop', id: 'one' }); await f.receive('stopped', 'one');
  await assertGone(f.events().filter(event => event.kind === 'descendant').flatMap(event => [event.pid, event.child]));
  f.start('two', 'server', first.localPort);
  assert.equal((await f.receive('started', 'two')).localPort, first.localPort);
  f.send({ cmd: 'stop', id: 'two' }); await f.receive('stopped', 'two');
});

test('closing during configuration cancels before a tunnel is registered', async t => {
  const f = await fixture(t); f.start('cancel', 'slow-config');
  while (!f.events().some(event => event.kind === 'descendant')) await pause(10);
  f.send({ cmd: 'stop', id: 'cancel' }); await f.receive('stopped', 'cancel');
  await assertGone(f.events().filter(event => event.kind === 'descendant').flatMap(event => [event.pid, event.child]));
  assert.ok(!f.events().some(event => event.kind === 'master'));
});

test('unreachable server times out before SSH startup', async t => {
  const f = await fixture(t, false); f.start('offline');
  const failure = await f.receive('error', 'offline');
  assert.equal(failure.retryable, true); assert.match(failure.message, /VPN/);
  assert.ok(!f.events().some(event => event.kind === 'master'));
});

test('configuration timeout kills its process and descendants', async t => {
  const f = await fixture(t); f.start('timeout', 'slow-config');
  const failure = await f.receive('error', 'timeout'); assert.equal(failure.retryable, true);
  await assertGone(f.events().filter(event => event.kind === 'descendant').flatMap(event => [event.pid, event.child]));
});

test('full startup deadline kills a stalled SSH process and descendants', async t => {
  const f = await fixture(t); f.start('timeout', 'slow-master');
  const failure = await f.receive('error', 'timeout', 33000);
  assert.equal(failure.retryable, true); assert.match(failure.message, /startup timed out/);
  await assertGone(f.events().filter(event => event.kind === 'descendant').flatMap(event => [event.pid, event.child]));
});

test('native host EOF cleans up attempts still connecting', async t => {
  const f = await fixture(t); f.start('shutdown', 'slow-master');
  while (!f.events().some(event => event.kind === 'descendant')) await pause(10);
  f.child.stdin.end(); await once(f.child, 'exit');
  await assertGone(f.events().filter(event => event.kind === 'descendant').flatMap(event => [event.pid, event.child]));
});

test('SSH authentication failure is visible and nonretryable', async t => {
  const f = await fixture(t); f.start('auth', 'auth-failure');
  const failure = await f.receive('error', 'auth');
  assert.equal(failure.retryable, false); assert.match(failure.message, /Permission denied/);
});

test('jump-host probe reaches the destination through the configured chain', async t => {
  const f = await fixture(t); f.start('jump', 'jump'); await f.receive('started', 'jump');
  const probe = f.events().find(event => event.kind === 'probe');
  assert.equal(probe.args.at(-1), 'ssh://last:2222');
  assert.equal(probe.args[probe.args.indexOf('-J') + 1], 'first');
  assert.match(probe.args[probe.args.indexOf('-W') + 1], /^\[127\.0\.0\.1\]:\d+$/);
  await assertGone([probe.pid]);
  f.send({ cmd: 'stop', id: 'jump' }); await f.receive('stopped', 'jump');
});

test('ProxyCommand probe is terminated after checking the server banner', async t => {
  const f = await fixture(t); f.start('proxy', 'proxy'); await f.receive('started', 'proxy');
  f.send({ cmd: 'stop', id: 'proxy' }); await f.receive('stopped', 'proxy');
});

test('occupied fixed port produces a visible error without starting SSH', async t => {
  const f = await fixture(t);
  const occupied = net.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  f.start('occupied', 'server', occupied.address().port);
  const failure = await f.receive('error', 'occupied');
  assert.equal(failure.retryable, false); assert.match(failure.message, /local port was not changed/);
  assert.equal(f.events().length, 0);
});

test('SSH process exit reports connection loss and cleans up descendants before recovery', async t => {
  const f = await fixture(t); f.start('lost');
  const started = await f.receive('started', 'lost');
  const master = f.events().find(event => event.kind === 'master');
  process.kill(master.pid, 'SIGTERM');
  await f.receive('exited', 'lost');
  await assertGone(f.events().filter(event => event.kind === 'descendant').flatMap(event => [event.pid, event.child]));
  f.start('recovered', 'server', started.localPort);
  assert.equal((await f.receive('started', 'recovered')).localPort, started.localPort);
  f.send({ cmd: 'stop', id: 'recovered' }); await f.receive('stopped', 'recovered');
});
