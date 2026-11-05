# Portluck

SSH port-forward to a remote port from the Chrome address bar, tied to a tab's lifetime.
Type `pf somenode:8888` in your browser address bar and Portluck runs `ssh -N -L 127.0.0.1:8888:127.0.0.1:8888 somenode`, opens `http://localhost:8888`, and tears the tunnel down when you close the tab.

![Portluck demo](assets/demo.gif)

Chrome extensions can't spawn `ssh`, so Portluck is two parts: `extension/` (MV3, owns the omnibox keyword and tab lifecycle) and `native-host/` (a small Rust binary that runs and supervises `ssh`).

## Prerequisites

- macOS with Chrome 120 or newer.
  Linux and other Chromium-based browsers are not tested.
- Rust toolchain.
- SSH (`ssh`). Your SSH config (`~/.ssh/config`) will be used to resolve hosts.

## Install

The extension ID is pinned (`key` in `manifest.json`) to `ieefaffakndbkfepmnpkolganahdnafg`, so there is no ID to copy around.

1. Build and register the host: `scripts/install.sh [chrome|brave|edge|canary]`.
   This compiles the Rust binary and writes the native-messaging manifest into the browser's `NativeMessagingHosts` directory, pointing Chrome at the binary and allowing only the pinned extension ID.
2. Load `extension/` unpacked at `chrome://extensions` (Developer mode on).

## Usage

Type `pf` ("port forward"), a space, then `[user@]host:port`:

```
pf somenode:8888            forward remote 8888 to localhost:8888
pf somenode:8888:9000       remote 8888 to localhost:9000 (choose the local port)
pf user@somenode:8888       connect as a specific SSH user
```

Closing the tab cancels connection attempts, retries, and the tunnel.

## Reconnection

After a network interruption, Portluck keeps the original tab and local port and retries automatically.
SSH checks established connections every 30 seconds and disconnects after two unanswered checks.
The extension popup shows connection status and the next retry time.
Click **Reconnect** to retry immediately, or **Reconnect and reload** to also reload the page after connection succeeds.
Ordinary reconnection preserves the page and its URL; an application with a broken connection may still need a reload.
Repeating `pf host:port` focuses the existing tab and reconnects it if disconnected.

Before connecting, Portluck checks the SSH server's response through the configured network route, including jump hosts and `ProxyCommand`.
The check has a 5-second deadline, including SSH configuration and DNS resolution.
If it fails, Portluck skips tunnel startup and shows the error; check your network and VPN.
Retries wait 30 seconds, then 1, 2, 4, and at most 5 minutes between attempts.
SSH startup has a 30-second total deadline, and expired attempts are terminated before another attempt starts.
Authentication errors, host-key errors, and local-port conflicts require manual retry after resolving the error.

## Defaults

- Local port defaults to the remote port; if busy, an unused one is picked and the tab uses it.
- An explicitly selected port, or a port retained for reconnection, must be available; Portluck reports a conflict otherwise.
- The tunnel is reachable only from your machine, not your LAN.
- Uses HTTP.

## Troubleshooting

- You get "native messaging host not found" or "forbidden": run `scripts/install.sh` and reload the extension.
- Tab won't load: check the popup for an SSH error.
  If connected, check that the remote service is running and whether it requires `https`.
- Updated the host or moved the repo? Re-run `scripts/install.sh`, then reload the extension.

Tab associations survive extension service worker restarts.
Restarting Chrome or reloading, disabling, or updating the extension clears them; run `pf` again in the desired tab.

## Development

Run `scripts/lint.sh` for formatting and lint checks, and `scripts/test.sh` for recovery and cancellation tests.
Tests require Node.js and local loopback sockets; the startup-deadline test takes 30 seconds.
Run `node --test tests/openssh.cjs` after `scripts/test.sh` to verify real SSH forwarding and jump hosts with temporary local keys and an isolated `/usr/sbin/sshd`.
