// Portluck native messaging host.
//
// Speaks Chrome's native messaging protocol (4-byte native-endian length prefix
// followed by JSON) on stdin/stdout, and manages one ssh port-forward per tunnel
// via the openssh crate. Each tunnel runs as its own task that owns its Session;
// stopping it (tab closed) or losing stdin (extension gone) tears the Session
// down through ssh's control master.

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use openssh::{ForwardType, KnownHosts, SessionBuilder};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};

const LOOPBACK: Ipv4Addr = Ipv4Addr::new(127, 0, 0, 1);
const HEALTH_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct Incoming {
    cmd: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default, rename = "remotePort")]
    remote_port: Option<u16>,
    #[serde(default, rename = "localPort")]
    local_port: Option<u16>,
}

struct Tunnel {
    stop: Arc<Notify>,
}

type Registry = Arc<Mutex<HashMap<String, Tunnel>>>;
type Sender = mpsc::UnboundedSender<String>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// openssh's top-level Display is generic ("failed to connect to the remote host");
// the actual ssh stderr is the source. Join the chain so the user sees the reason.
fn describe(e: &openssh::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    parts.join(": ")
}

fn pick_free_port(preferred: u16) -> u16 {
    if preferred != 0 && TcpListener::bind((LOOPBACK, preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind((LOOPBACK, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

async fn run_tunnel(
    reg: Registry,
    tx: Sender,
    id: String,
    host: String,
    remote: u16,
    want_local: u16,
) {
    let local = pick_free_port(want_local);

    let mut builder = SessionBuilder::default();
    builder
        .known_hosts_check(KnownHosts::Strict)
        .connect_timeout(Duration::from_secs(10))
        .server_alive_interval(Duration::from_secs(30));

    let session = match builder.connect(&host).await {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.send(json!({"type":"error","id":id,"message":describe(&e)}).to_string());
            return;
        }
    };

    if let Err(e) = session
        .request_port_forward(ForwardType::Local, (LOOPBACK, local), (LOOPBACK, remote))
        .await
    {
        let _ = tx.send(json!({"type":"error","id":id,"message":format!("port forward failed: {}", describe(&e))}).to_string());
        let _ = session.close().await;
        return;
    }

    let stop = Arc::new(Notify::new());
    lock(&reg).insert(id.clone(), Tunnel { stop: stop.clone() });
    let _ = tx.send(json!({"type":"started","id":id,"localPort":local}).to_string());

    let mut ticker = tokio::time::interval(HEALTH_INTERVAL);
    ticker.tick().await; // the first tick is immediate; skip it

    let lost = loop {
        tokio::select! {
            _ = stop.notified() => break false,
            _ = ticker.tick() => {
                if session.check().await.is_err() {
                    break true;
                }
            }
        }
    };

    lock(&reg).remove(&id);
    if lost {
        let _ = tx.send(json!({"type":"exited","id":id,"message":"connection lost"}).to_string());
    }
    let _ = session.close().await;
}

fn stop_tunnel(reg: &Registry, id: &str) {
    if let Some(t) = lock(reg).get(id) {
        t.stop.notify_one();
    }
}

async fn shutdown(reg: &Registry) {
    let stops: Vec<Arc<Notify>> = lock(reg).values().map(|t| t.stop.clone()).collect();
    for s in &stops {
        s.notify_one();
    }
    if !stops.is_empty() {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn read_message(stdin: &mut tokio::io::Stdin) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    if stdin.read_exact(&mut len).await.is_err() {
        return None;
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n == 0 {
        return Some(Vec::new());
    }
    if n > 64 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; n];
    if stdin.read_exact(&mut buf).await.is_err() {
        return None;
    }
    Some(buf)
}

#[tokio::main]
async fn main() {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Single writer: frame each message with a native-endian u32 length prefix.
    tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(s) = rx.recv().await {
            let b = s.as_bytes();
            if out
                .write_all(&(b.len() as u32).to_ne_bytes())
                .await
                .is_err()
            {
                break;
            }
            if out.write_all(b).await.is_err() {
                break;
            }
            if out.flush().await.is_err() {
                break;
            }
        }
    });

    let reg: Registry = Arc::new(Mutex::new(HashMap::new()));
    let mut stdin = tokio::io::stdin();

    while let Some(bytes) = read_message(&mut stdin).await {
        if bytes.is_empty() {
            continue;
        }
        let msg: Incoming = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(
                    json!({"type":"error","id":"","message":format!("bad message: {e}")})
                        .to_string(),
                );
                continue;
            }
        };
        match msg.cmd.as_str() {
            "start" => {
                let id = msg.id.unwrap_or_default();
                let (Some(host), Some(remote)) = (msg.host, msg.remote_port) else {
                    let _ = tx.send(
                        json!({"type":"error","id":id,"message":"missing host or remotePort"})
                            .to_string(),
                    );
                    continue;
                };
                if id.is_empty() {
                    let _ =
                        tx.send(json!({"type":"error","id":"","message":"missing id"}).to_string());
                    continue;
                }
                let local = msg.local_port.unwrap_or(remote);
                tokio::spawn(run_tunnel(reg.clone(), tx.clone(), id, host, remote, local));
            }
            "stop" => {
                if let Some(id) = msg.id {
                    stop_tunnel(&reg, &id);
                }
            }
            "ping" => {
                let _ = tx.send(json!({"type":"pong"}).to_string());
            }
            "list" => {
                let ids: Vec<String> = lock(&reg).keys().cloned().collect();
                let _ = tx.send(json!({"type":"list","ids":ids}).to_string());
            }
            _ => {}
        }
    }

    shutdown(&reg).await;
}
