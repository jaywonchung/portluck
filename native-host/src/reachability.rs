use std::collections::HashMap;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{lookup_host, TcpSocket};
use tokio::process::Command;

use crate::process::Processes;
use crate::{Failure, Result};

fn required<'a>(config: &'a HashMap<String, String>, key: &str) -> Result<&'a str> {
    config
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| Failure::permanent(format!("SSH configuration did not provide {key}")))
}

fn enabled<'a>(config: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    config
        .get(key)
        .map(String::as_str)
        .filter(|value| *value != "none")
}

fn expand_proxy(command: &str, config: &HashMap<String, String>, original: &str) -> Result<String> {
    let mut output = String::new();
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            output.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => output.push('%'),
            Some('h') => output.push_str(required(config, "hostname")?),
            Some('p') => output.push_str(required(config, "port")?),
            Some('r') => output.push_str(required(config, "user")?),
            Some('n') => output.push_str(original.rsplit('@').next().unwrap_or(original)),
            token => {
                return Err(Failure::permanent(format!(
                    "Unsupported ProxyCommand token: {token:?}"
                )))
            }
        }
    }
    Ok(output)
}

async fn banner(reader: impl AsyncRead + Unpin) -> Result<()> {
    let mut reader = BufReader::new(reader.take(8192));
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await.map_err(|e| {
            Failure::temporary(format!(
                "SSH server response failed: {e}. Check network or VPN."
            ))
        })? == 0
        {
            return Err(Failure::temporary(
                "SSH server did not respond. Check network or VPN.",
            ));
        }
        if line.starts_with("SSH-2.0-") || line.starts_with("SSH-1.99-") {
            return Ok(());
        }
    }
}

async fn receive_fd(socket: &tokio::net::UnixStream) -> std::io::Result<OwnedFd> {
    loop {
        socket.readable().await?;
        let result = socket.try_io(tokio::io::Interest::READABLE, || {
            let mut byte = [0u8];
            let mut control = [0usize; 16];
            let mut iov = libc::iovec {
                iov_base: byte.as_mut_ptr().cast(),
                iov_len: 1,
            };
            // recvmsg writes into aligned storage; each received descriptor becomes owned here.
            unsafe {
                let mut message: libc::msghdr = std::mem::zeroed();
                message.msg_iov = &mut iov;
                message.msg_iovlen = 1;
                message.msg_control = control.as_mut_ptr().cast();
                message.msg_controllen = std::mem::size_of_val(&control) as _;
                if libc::recvmsg(socket.as_raw_fd(), &mut message, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut received = None;
                let mut header = libc::CMSG_FIRSTHDR(&message);
                while !header.is_null() {
                    if (*header).cmsg_level == libc::SOL_SOCKET
                        && (*header).cmsg_type == libc::SCM_RIGHTS
                    {
                        let count = ((*header).cmsg_len as usize - libc::CMSG_LEN(0) as usize)
                            / std::mem::size_of::<i32>();
                        for i in 0..count {
                            let raw = libc::CMSG_DATA(header)
                                .cast::<i32>()
                                .add(i)
                                .read_unaligned();
                            let owned = OwnedFd::from_raw_fd(raw);
                            if received.is_none() {
                                received = Some(owned);
                            }
                        }
                    }
                    header = libc::CMSG_NXTHDR(&message, header);
                }
                let fd = received.ok_or_else(|| {
                    std::io::Error::other("Proxy did not pass a connected socket")
                })?;
                if libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(fd)
            }
        });
        match result {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            result => return result,
        }
    }
}

pub async fn check(host: &str, processes: &mut Processes) -> Result<()> {
    let mut command = processes.ssh();
    command.arg("-G").arg(host);
    let index = processes.spawn(command, false)?;
    if !processes.wait(index).await?.success() {
        return Err(Failure::ssh(
            processes.error(index, "Could not read SSH configuration"),
        ));
    }
    let mut config = HashMap::new();
    for line in processes.output(index)?.lines() {
        if let Some((key, value)) = line.split_once(' ') {
            config
                .entry(key.to_string())
                .or_insert_with(|| value.to_string());
        }
    }
    let hostname = required(&config, "hostname")?;
    let port: u16 = required(&config, "port")?
        .parse()
        .map_err(|_| Failure::permanent("Invalid SSH port"))?;

    let proxy = if let Some(jumps) = enabled(&config, "proxyjump") {
        let mut hops: Vec<_> = jumps.split(',').collect();
        let last = hops
            .pop()
            .ok_or_else(|| Failure::permanent("Empty ProxyJump"))?;
        let mut command = processes.ssh();
        command
            .args([
                "-S",
                "none",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPersist=no",
                "-W",
            ])
            .arg(format!("[{hostname}]:{port}"));
        if !hops.is_empty() {
            command.arg("-J").arg(hops.join(","));
        }
        command.arg(if last.starts_with("ssh://") {
            last.to_string()
        } else {
            format!("ssh://{last}")
        });
        Some(command)
    } else if let Some(proxy) = enabled(&config, "proxycommand") {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let mut command = Command::new(shell);
        command
            .arg("-c")
            .arg(format!("exec {}", expand_proxy(proxy, &config, host)?));
        Some(command)
    } else {
        None
    };

    if let Some(mut command) = proxy {
        command.stdin(Stdio::piped());
        let (index, result) = if enabled(&config, "proxyjump").is_none()
            && config.get("proxyusefdpass").is_some_and(|v| v == "yes")
        {
            let (parent, child) = std::os::unix::net::UnixStream::pair()?;
            parent.set_nonblocking(true)?;
            let parent = tokio::net::UnixStream::from_std(parent)?;
            let index = processes.spawn_socket(command, child)?;
            let result: Result<()> = async {
                let fd = receive_fd(&parent).await?;
                let stream = std::net::TcpStream::from(fd);
                stream.set_nonblocking(true)?;
                let mut stream = tokio::net::TcpStream::from_std(stream)?;
                stream.write_all(b"SSH-2.0-Portluck_Probe\r\n").await?;
                banner(stream).await
            }
            .await;
            (index, result)
        } else {
            let index = processes.spawn(command, true)?;
            let stdin = processes.children[index]
                .child
                .stdin
                .as_mut()
                .ok_or_else(|| Failure::permanent("Proxy stdin is unavailable"))?;
            stdin.write_all(b"SSH-2.0-Portluck_Probe\r\n").await?;
            let stdout = processes.children[index]
                .child
                .stdout
                .take()
                .ok_or_else(|| Failure::permanent("Proxy stdout is unavailable"))?;
            (index, banner(stdout).await)
        };
        // A probe never keeps its authenticated jump connections alive.
        processes.stop(index).await;
        if let Err(e) = result {
            let detail = processes.error(index, &e.message);
            let failure = Failure::ssh(detail);
            return Err(if failure.message == e.message {
                e
            } else {
                failure
            });
        }
        return Ok(());
    }

    let probe = DirectProbe {
        hostname: hostname.to_string(),
        port,
        family: required(&config, "addressfamily")?.to_string(),
        bind_address: enabled(&config, "bindaddress").map(str::to_string),
        bind_interface: enabled(&config, "bindinterface").map(str::to_string),
    };
    // DNS resolution runs in an owned child so a blocked system resolver is cancellable.
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--probe-tcp")
        .arg(serde_json::to_string(&probe).map_err(|e| Failure::permanent(e.to_string()))?);
    let index = processes.spawn(command, false)?;
    let status = processes.wait(index).await?;
    if status.success() {
        Ok(())
    } else {
        Err(Failure {
            message: processes.error(index, "Server reachability check failed"),
            retryable: status.code() == Some(2),
        })
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DirectProbe {
    hostname: String,
    port: u16,
    family: String,
    bind_address: Option<String>,
    bind_interface: Option<String>,
}

fn bind_interface(socket: &TcpSocket, name: &str, ipv4: bool) -> Result<()> {
    use std::os::fd::AsRawFd;
    let name =
        std::ffi::CString::new(name).map_err(|_| Failure::permanent("Invalid BindInterface"))?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_BINDTODEVICE,
            name.as_ptr().cast(),
            name.as_bytes_with_nul().len() as libc::socklen_t,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        let index = libc::if_nametoindex(name.as_ptr());
        if index == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let (level, option) = if ipv4 {
            (libc::IPPROTO_IP, libc::IP_BOUND_IF)
        } else {
            (libc::IPPROTO_IPV6, libc::IPV6_BOUND_IF)
        };
        libc::setsockopt(
            socket.as_raw_fd(),
            level,
            option,
            (&index as *const u32).cast(),
            std::mem::size_of_val(&index) as libc::socklen_t,
        )
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err(Failure::permanent(
        "BindInterface is supported only on macOS and Linux",
    ));
    #[cfg(target_os = "linux")]
    let _ = ipv4;
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub async fn direct_probe(input: &str) -> Result<()> {
    let probe: DirectProbe =
        serde_json::from_str(input).map_err(|e| Failure::permanent(e.to_string()))?;
    if !["any", "inet", "inet6"].contains(&probe.family.as_str()) {
        return Err(Failure::permanent("Invalid AddressFamily"));
    }
    let addresses: Vec<_> = lookup_host((probe.hostname.as_str(), probe.port))
        .await
        .map_err(|e| {
            Failure::temporary(format!(
                "Cannot resolve SSH server: {e}. Check network or VPN."
            ))
        })?
        .filter(|a| match probe.family.as_str() {
            "inet" => a.is_ipv4(),
            "inet6" => a.is_ipv6(),
            _ => true,
        })
        .collect();
    let bind_addresses: Vec<_> = if let Some(ref address) = probe.bind_address {
        lookup_host((address.as_str(), 0))
            .await
            .map_err(|e| Failure::temporary(format!("Cannot resolve BindAddress: {e}")))?
            .collect()
    } else {
        Vec::new()
    };
    let mut probes = tokio::task::JoinSet::new();
    for address in addresses {
        let bind = bind_addresses
            .iter()
            .find(|a| a.is_ipv4() == address.is_ipv4())
            .copied();
        if probe.bind_address.is_some() && bind.is_none() {
            continue;
        }
        let interface = probe.bind_interface.clone();
        probes.spawn(async move {
            let socket = if address.is_ipv4() {
                TcpSocket::new_v4()?
            } else {
                TcpSocket::new_v6()?
            };
            if let Some(bind) = bind {
                socket.bind(bind)?;
            }
            if let Some(interface) = interface {
                bind_interface(&socket, &interface, address.is_ipv4())?;
            }
            let mut stream = socket.connect(address).await.map_err(|e| {
                Failure::temporary(format!("Server unreachable: {e}. Check network or VPN."))
            })?;
            stream
                .write_all(b"SSH-2.0-Portluck_Probe\r\n")
                .await
                .map_err(|e| Failure::temporary(format!("SSH server probe failed: {e}")))?;
            banner(stream).await
        });
    }
    let mut error = Failure::temporary("SSH server has no usable address. Check network or VPN.");
    while let Some(result) = probes.join_next().await {
        match result {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(e)) => error = e,
            Err(e) => return Err(Failure::permanent(format!("Reachability task failed: {e}"))),
        }
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn receives_proxy_socket_descriptor() {
        let (parent, child) = std::os::unix::net::UnixStream::pair().unwrap();
        parent.set_nonblocking(true).unwrap();
        let parent = tokio::net::UnixStream::from_std(parent).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let stream = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let mut byte = [0u8];
        let mut control = [0usize; 16];
        let mut iov = libc::iovec {
            iov_base: byte.as_mut_ptr().cast(),
            iov_len: 1,
        };
        unsafe {
            let mut message: libc::msghdr = std::mem::zeroed();
            message.msg_iov = &mut iov;
            message.msg_iovlen = 1;
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = libc::CMSG_SPACE(std::mem::size_of::<i32>() as _) as _;
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<i32>() as _) as _;
            libc::CMSG_DATA(header)
                .cast::<i32>()
                .write_unaligned(stream.as_raw_fd());
            assert_eq!(libc::sendmsg(child.as_raw_fd(), &message, 0), 1);
        }
        let received = std::net::TcpStream::from(receive_fd(&parent).await.unwrap());
        assert_eq!(
            received.peer_addr().unwrap(),
            listener.local_addr().unwrap()
        );
    }

    #[tokio::test]
    async fn accepts_ssh_banner_after_preamble() {
        banner(&b"notice\r\nSSH-2.0-OpenSSH\r\n"[..]).await.unwrap();
        assert!(banner(&b"HTTP/1.1 200 OK\r\n"[..]).await.is_err());
    }

    #[test]
    fn proxy_tokens_use_resolved_destination() {
        let config = HashMap::from([
            ("hostname".into(), "private.example".into()),
            ("port".into(), "2222".into()),
            ("user".into(), "alice".into()),
        ]);
        assert_eq!(
            expand_proxy("nc %h %p # %r %n %%", &config, "alice@alias").unwrap(),
            "nc private.example 2222 # alice alias %"
        );
        assert!(expand_proxy("nc %x", &config, "alias").is_err());
    }
}
