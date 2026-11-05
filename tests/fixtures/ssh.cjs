#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const host = args.at(-1);
function record(kind, extra = {}) {
  fs.appendFileSync(process.env.PORTLUCK_TEST_LOG, JSON.stringify({ kind, host, pid: process.pid, ...extra }) + '\n');
}
function hang() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  record('descendant', { child: child.pid });
  setInterval(() => {}, 1000);
}
if (args.includes('-G')) {
  record('config');
  if (host === 'slow-config') hang();
  else {
    const lines = ['hostname 127.0.0.1', `port ${process.env.PORTLUCK_TEST_PORT}`, 'user test', 'addressfamily any'];
    if (host === 'jump') lines.push('proxyjump first,last:2222');
    if (host === 'proxy') lines.push(`proxycommand ${process.execPath} ${process.env.PORTLUCK_TEST_PROXY}`);
    console.log(lines.join('\n'));
  }
} else if (args.includes('-W')) {
  record('probe', { args });
  process.stdout.write('SSH-2.0-test\r\n');
  process.stdin.resume();
} else if (args.includes('-O')) {
  const socket = args[args.indexOf('-S') + 1];
  const forward = args[args.indexOf('-L') + 1];
  const port = Number(forward.split(':')[1]);
  const client = net.connect(socket, () => client.write(String(port)));
  client.on('data', data => process.exit(data.toString() === 'ok' ? 0 : 1));
  client.on('error', error => { console.error(error.message); process.exit(1); });
} else {
  record('master');
  if (host === 'auth-failure') { console.error('Permission denied (publickey).'); process.exit(255); }
  if (host === 'slow-master') hang();
  else {
    const socket = args[args.indexOf('-S') + 1];
    const listeners = [];
    net.createServer(client => {
      client.once('data', data => {
        const listener = net.createServer(socket => socket.end('forwarded'));
        listeners.push(listener);
        listener.on('error', () => client.end('error'));
        listener.listen(Number(data.toString()), '127.0.0.1', () => client.end('ok'));
      });
    }).listen(socket);
    hang();
  }
}
