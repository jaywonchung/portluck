// Run with: node --test tests/openssh.cjs
// Requires local ssh, ssh-keygen, and /usr/sbin/sshd; all traffic stays on loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}


test('real OpenSSH forwards, reconnects on the same port, and follows ProxyJump', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portluck-openssh-tests-'));
  const children = [];
  const app = http.createServer((request, response) => response.end('portluck-local-app'));
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin?.end();
        child.kill(); await once(child, 'exit');
      }
    }
    await new Promise(resolve => app.close(resolve));
    fs.rmSync(dir, { recursive: true });
  });
  for (const name of ['host', 'client']) {
    const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, name)]);
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const sshPort = await unusedPort();
  const config = path.join(dir, 'sshd_config');
  fs.writeFileSync(config, `ListenAddress 127.0.0.1\nPort ${sshPort}\nHostKey ${dir}/host\nAuthorizedKeysFile ${dir}/client.pub\nPidFile ${dir}/sshd.pid\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes yes\n`);
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(daemon);
  let sshdLog = ''; daemon.stderr.on('data', data => { sshdLog += data; });
  for (let i = 0; i < 100 && !sshdLog.includes('Server listening'); i++) {
    assert.equal(daemon.exitCode, null, sshdLog); await pause(10);
  }
  assert.match(sshdLog, /Server listening/);
  fs.writeFileSync(path.join(dir, 'known_hosts'), `[127.0.0.1]:${sshPort} ${fs.readFileSync(path.join(dir, 'host.pub'), 'utf8')}`);
  const clientConfig = path.join(dir, 'config');
  fs.writeFileSync(clientConfig, `Host through-jump\n  ProxyJump hop\nHost *\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User ${os.userInfo().username}\n  IdentityFile ${dir}/client\n  IdentitiesOnly yes\n  UserKnownHostsFile ${dir}/known_hosts\n  StrictHostKeyChecking yes\n  ControlMaster auto\n  ControlPersist 600\n  ControlPath ${dir}/shared-%n\n`);
  const wrapper = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const configs = args.flatMap((arg, index) => arg === '-F' ? [args[index + 1]] : []);
for (const config of configs) {
  if (config !== '/dev/null') {
    const source = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(config, source.replace('Include ~/.ssh/config', 'Include "' + process.env.PORTLUCK_TEST_CONFIG + '"').replace('Include /etc/ssh/ssh_config', ''));
  }
}
const child = spawn('/usr/bin/ssh', args, { stdio: 'inherit' });
child.on('exit', code => process.exit(code === null ? 1 : code));
`;
  fs.writeFileSync(path.join(dir, 'ssh'), wrapper, { mode: 0o755 });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const remotePort = app.address().port;
  const native = spawn(path.resolve('native-host/target/debug/portluck-host'), [], {
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, PORTLUCK_TEST_CONFIG: clientConfig }, stdio: ['pipe', 'pipe', 'pipe']
  });
  children.push(native);
  let stderr = ''; native.stderr.on('data', data => { stderr += data; });
  const messages = []; let buffer = Buffer.alloc(0);
  native.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      messages.push(JSON.parse(buffer.subarray(4, length + 4).toString()));
      buffer = buffer.subarray(length + 4);
    }
  });
  function send(message) {
    const body = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    native.stdin.write(Buffer.concat([header, body]));
  }
  async function receive(type, id) {
    for (let i = 0; i < 3500; i++) {
      const failure = messages.find(message => message.type === 'error' && message.id === id);
      assert.ok(!failure, JSON.stringify(failure) + '\n' + sshdLog);
      const index = messages.findIndex(message => message.type === type && (id === undefined || id === message.id));
      if (index >= 0) return messages.splice(index, 1)[0];
      assert.equal(native.exitCode, null, stderr); await pause(10);
    }
    throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(messages)}`);
  }
  await receive('ready');
  let localPort = null;
  for (const [id, host] of [['initial', 'direct'], ['reconnect', 'direct'], ['jump', 'through-jump']]) {
    send({ cmd: 'start', id, host, remotePort, localPort, strictLocalPort: localPort !== null });
    const started = await receive('started', id);
    if (localPort !== null) assert.equal(started.localPort, localPort);
    localPort = started.localPort;
    const response = await fetch(`http://127.0.0.1:${localPort}/path?query=yes`, { signal: AbortSignal.timeout(5000) });
    assert.equal(await response.text(), 'portluck-local-app');
    send({ cmd: 'stop', id }); await receive('stopped', id);
  }
  const shared = fs.readdirSync(dir).filter(name => name.startsWith('shared-'));
  for (const socket of shared) spawnSync('/usr/bin/ssh', ['-F', '/dev/null', '-S', path.join(dir, socket), '-O', 'exit', '127.0.0.1']);
  assert.deepEqual(shared, [], 'Jump connections must not start persistent shared masters');
  native.stdin.end(); await once(native, 'exit');
  assert.equal(native.exitCode, 0, stderr);
});
