//! Native messaging host with cancellable, foreground SSH processes.

mod process;
mod reachability;

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};

use process::Processes;

const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct Failure {
    message: String,
    retryable: bool,
}

impl Failure {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn temporary(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    fn ssh(message: String) -> Self {
        let lower = message.to_lowercase();
        let permanent = [
            "permission denied",
            "host key verification failed",
            "remote host identification has changed",
            "bad configuration",
            "bad owner or permissions",
            "invalid ",
            "unknown option",
            "no matching ",
        ];
        let transient = [
            "timed out",
            "connection refused",
            "connection reset",
            "connection closed",
            "network is unreachable",
            "no route to host",
            "could not resolve hostname",
            "broken pipe",
            "operation timed out",
        ];
        let retryable = !permanent.iter().any(|s| lower.contains(s))
            && transient.iter().any(|s| lower.contains(s));
        Self { message, retryable }
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::permanent(error.to_string())
    }
}

type Result<T> = std::result::Result<T, Failure>;
type Sender = mpsc::UnboundedSender<Value>;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Incoming {
    Start {
        id: String,
        host: String,
        #[serde(rename = "remotePort")]
        remote: u16,
        #[serde(rename = "localPort")]
        local: Option<u16>,
        #[serde(rename = "strictLocalPort")]
        strict: bool,
    },
    Stop {
        id: String,
    },
    Ping,
    List,
}

struct Spec {
    host: String,
    remote: u16,
    local: Option<u16>,
    strict: bool,
}

fn validate(spec: &Spec) -> Result<()> {
    if spec.remote == 0 || spec.local == Some(0) {
        return Err(Failure::permanent("Ports must be between 1 and 65535"));
    }
    if spec.strict && spec.local.is_none() {
        return Err(Failure::permanent(
            "Reconnection requires the original local port",
        ));
    }
    let name = spec.host.rsplit('@').next().unwrap_or("");
    if name.is_empty()
        || name.starts_with('-')
        || spec.host.starts_with('-')
        || spec.host.matches('@').count() > 1
        || !spec
            .host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-@".contains(&c))
    {
        return Err(Failure::permanent("Invalid SSH destination"));
    }
    Ok(())
}

fn pick_port(spec: &Spec) -> Result<u16> {
    let preferred = spec.local.unwrap_or(spec.remote);
    match TcpListener::bind((LOOPBACK, preferred)) {
        Ok(listener) => Ok(listener.local_addr()?.port()),
        Err(e) if spec.strict || spec.local.is_some() => Err(Failure::permanent(format!(
            "Cannot bind localhost:{preferred}: {e}. The local port was not changed."
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            Ok(TcpListener::bind((LOOPBACK, 0))?.local_addr()?.port())
        }
        Err(e) => Err(e.into()),
    }
}

async fn start(
    spec: &Spec,
    processes: &mut Processes,
    tx: &Sender,
    id: &str,
) -> Result<(usize, u16)> {
    validate(spec)?;
    let local = pick_port(spec)?;
    let _ = tx.send(json!({"type":"progress", "id":id, "status":"checking"}));
    timeout(PROBE_TIMEOUT, reachability::check(&spec.host, processes))
        .await
        .map_err(|_| {
            Failure::temporary("Server reachability check timed out. Check network or VPN.")
        })??;
    let _ = tx.send(json!({"type":"progress", "id":id, "status":"connecting"}));

    let socket = processes.directory.path().join("control");
    let mut command = processes.ssh();
    command
        .args(["-M", "-N", "-T", "-S"])
        .arg(&socket)
        .args([
            "-o",
            "ControlPersist=no",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=2",
        ])
        .arg(&spec.host);
    let master = processes.spawn(command, false)?;
    loop {
        if let Some(status) = processes.children[master].child.try_wait()? {
            return Err(Failure::ssh(
                processes.error(master, &format!("SSH exited: {status}")),
            ));
        }
        if socket.exists() {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }
    // The forward command's acknowledgement confirms that the listener was installed.
    let mut command = processes.ssh();
    command
        .args(["-F", "/dev/null"])
        .args(["-S"])
        .arg(&socket)
        .args([
            "-O",
            "forward",
            "-o",
            "ClearAllForwardings=no",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
        ])
        .arg(format!("127.0.0.1:{local}:127.0.0.1:{}", spec.remote))
        .arg(&spec.host);
    let forward = processes.spawn(command, false)?;
    let status = processes.wait(forward).await?;
    if !status.success() {
        return Err(Failure::permanent(
            processes.error(forward, "Could not install port forwarding"),
        ));
    }
    Ok((master, local))
}

async fn run(spec: Spec, stop: Arc<Notify>, tx: Sender, id: String) -> String {
    let mut processes = match Processes::new() {
        Ok(p) => p,
        Err(e) => {
            let _ = tx
                .send(json!({"type":"error", "id":id, "message":e.to_string(), "retryable":false}));
            return id;
        }
    };
    let outcome = tokio::select! {
        biased;
        _ = stop.notified() => None,
        outcome = timeout(START_TIMEOUT, start(&spec, &mut processes, &tx, &id)) => {
            Some(outcome.unwrap_or_else(|_| Err(Failure::temporary("SSH startup timed out. Check network or VPN."))))
        }
    };
    let message = match outcome {
        None => json!({"type":"stopped", "id":id}),
        Some(Err(e)) => {
            json!({"type":"error", "id":id, "message":e.message, "retryable":e.retryable})
        }
        Some(Ok((master, local))) => {
            let _ = tx.send(json!({"type":"started", "id":id, "localPort":local}));
            tokio::select! {
                biased;
                _ = stop.notified() => json!({"type":"stopped", "id":id}),
                result = processes.children[master].child.wait() => {
                    let detail = match result {
                        Ok(status) => processes.error(master, &format!("SSH connection closed ({status})")),
                        Err(e) => e.to_string(),
                    };
                    json!({"type":"exited", "id":id, "message":detail})
                }
            }
        }
    };
    // A terminal reply is sent only after every owned process has been stopped.
    processes.shutdown().await;
    let _ = tx.send(message);
    id
}

async fn read_message(stdin: &mut tokio::io::Stdin) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match stdin.read_exact(&mut len).await {
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        result => {
            result?;
        }
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n == 0 || n > 64 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid native message length",
        ));
    }
    let mut buf = vec![0; n];
    stdin.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--probe-tcp") {
        let input = std::env::args().nth(2).unwrap_or_default();
        match reachability::direct_probe(&input).await {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{}", error.message);
                std::process::exit(if error.retryable { 2 } else { 1 });
            }
        }
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(value) = rx.recv().await {
            let bytes = value.to_string().into_bytes();
            out.write_all(&(bytes.len() as u32).to_ne_bytes()).await?;
            out.write_all(&bytes).await?;
            out.flush().await?;
        }
        Ok::<_, std::io::Error>(())
    });
    let _ = tx.send(json!({"type":"ready", "protocol":2}));
    let mut registry: HashMap<String, Arc<Notify>> = HashMap::new();
    let mut tasks = JoinSet::new();
    let mut stdin = tokio::io::stdin();
    // read_message must not be cancelled between the length prefix and its payload.
    let (input_tx, mut input_rx) = mpsc::channel(16);
    let reader = tokio::spawn(async move {
        while let Ok(Some(bytes)) = read_message(&mut stdin).await {
            if input_tx.send(bytes).await.is_err() {
                break;
            }
        }
    });
    loop {
        tokio::select! {
            result = tasks.join_next(), if !tasks.is_empty() => {
                match result {
                    Some(Ok(id)) => { registry.remove(&id); }
                    Some(Err(e)) => { eprintln!("Tunnel task failed: {e}"); break; }
                    None => {}
                }
            }
            bytes = input_rx.recv() => {
                let Some(bytes) = bytes else { break; };
                let message: Incoming = match serde_json::from_slice(&bytes) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = tx.send(json!({"type":"error", "id":"", "message":format!("Invalid request: {e}"), "retryable":false}));
                        continue;
                    }
                };
                match message {
                    Incoming::Start { id, host, remote, local, strict } => {
                        if id.is_empty() || registry.contains_key(&id) {
                            let _ = tx.send(json!({"type":"error", "id":id, "message":"Missing or duplicate attempt ID", "retryable":false}));
                            continue;
                        }
                        let stop = Arc::new(Notify::new());
                        registry.insert(id.clone(), stop.clone());
                        tasks.spawn(run(Spec { host, remote, local, strict }, stop, tx.clone(), id));
                    }
                    Incoming::Stop { id } => {
                        if let Some(stop) = registry.get(&id) { stop.notify_one(); }
                        else { let _ = tx.send(json!({"type":"stopped", "id":id})); }
                    }
                    Incoming::Ping => { let _ = tx.send(json!({"type":"pong"})); }
                    Incoming::List => {
                        let ids: Vec<_> = registry.keys().collect();
                        let _ = tx.send(json!({"type":"list", "ids":ids}));
                    }
                }
            }
            _ = sleep(Duration::from_secs(1)) => {
                if writer.is_finished() { break; }
            }
        }
    }
    reader.abort();
    for stop in registry.values() {
        stop.notify_one();
    }
    while tasks.join_next().await.is_some() {}
    drop(tx);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_cannot_change_an_occupied_port() {
        let listener = TcpListener::bind((LOOPBACK, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut spec = Spec {
            host: "example".into(),
            remote: port,
            local: Some(port),
            strict: true,
        };
        assert!(!pick_port(&spec).unwrap_err().retryable);
        spec.strict = false;
        assert!(pick_port(&spec).is_err());
        spec.local = None;
        assert_ne!(pick_port(&spec).unwrap(), port);
    }

    #[test]
    fn authentication_errors_do_not_retry() {
        assert!(!Failure::ssh("Permission denied (publickey).".into()).retryable);
        assert!(!Failure::ssh("Host key verification failed.".into()).retryable);
        assert!(Failure::ssh("Connection timed out".into()).retryable);
    }
}
