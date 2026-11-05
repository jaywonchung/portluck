use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};

use tempfile::TempDir;
use tokio::process::{Child, Command};

pub struct OwnedProcess {
    pub child: Child,
    group: Option<i32>,
    stderr: PathBuf,
    stdout: PathBuf,
}

impl OwnedProcess {
    fn kill_group(&mut self) {
        if let Some(group) = self.group.take() {
            // Each child starts a private process group, including its proxy children.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.kill_group();
    }
}

pub struct Processes {
    pub children: Vec<OwnedProcess>,
    pub directory: TempDir,
}

fn read_limited(path: &PathBuf) -> io::Result<String> {
    let mut text = String::new();
    File::open(path)?
        .take(64 * 1024)
        .read_to_string(&mut text)?;
    Ok(text)
}

impl Processes {
    pub fn new() -> io::Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("portluck-ssh-")
            .tempdir_in("/tmp")?;
        // OpenSSH passes -F to implicit jump connections, keeping them in the owned process group.
        fs::write(
            directory.path().join("ssh_config"),
            concat!(
                "Host *\n",
                "  BatchMode yes\n",
                "  StrictHostKeyChecking yes\n",
                "  ConnectTimeout 10\n",
                "  ConnectionAttempts 1\n",
                "  ForkAfterAuthentication no\n",
                "  PermitLocalCommand no\n",
                "  ControlMaster no\n",
                "  ControlPersist no\n",
                "  ControlPath none\n",
                "Include ~/.ssh/config\n",
                "Host *\n",
                "Include /etc/ssh/ssh_config\n"
            ),
        )?;
        Ok(Self {
            children: Vec::new(),
            directory,
        })
    }

    pub fn ssh(&self) -> Command {
        let mut command = Command::new("ssh");
        command
            .arg("-F")
            .arg(self.directory.path().join("ssh_config"));
        command
    }

    pub fn spawn(&mut self, mut command: Command, stream: bool) -> io::Result<usize> {
        self.spawn_inner(&mut command, stream, None)
    }

    pub fn spawn_socket(&mut self, mut command: Command, socket: UnixStream) -> io::Result<usize> {
        self.spawn_inner(&mut command, true, Some(socket))
    }

    fn spawn_inner(
        &mut self,
        command: &mut Command,
        stream: bool,
        socket: Option<UnixStream>,
    ) -> io::Result<usize> {
        let index = self.children.len();
        let stderr = self.directory.path().join(format!("{index}.stderr"));
        let stdout = self.directory.path().join(format!("{index}.stdout"));
        command
            .process_group(0)
            .kill_on_drop(true)
            .stderr(File::create(&stderr)?);
        if let Some(socket) = socket {
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::from(OwnedFd::from(socket)));
        } else if stream {
            // Keep stdin open while a proxy relays the server's SSH banner.
            command.stdin(Stdio::piped()).stdout(Stdio::piped());
        } else {
            command.stdin(Stdio::null()).stdout(File::create(&stdout)?);
        }
        let child = command.spawn()?;
        let group = child.id().map(|id| id as i32);
        self.children.push(OwnedProcess {
            child,
            group,
            stderr,
            stdout,
        });
        Ok(index)
    }

    pub async fn wait(&mut self, index: usize) -> io::Result<ExitStatus> {
        let result = self.children[index].child.wait().await;
        self.children[index].kill_group();
        result
    }

    pub fn output(&self, index: usize) -> io::Result<String> {
        read_limited(&self.children[index].stdout)
    }

    pub fn error(&self, index: usize, context: &str) -> String {
        match read_limited(&self.children[index].stderr) {
            Ok(text) if !text.trim().is_empty() => text.trim().chars().take(4096).collect(),
            Ok(_) => context.to_string(),
            Err(e) => format!("{context}; could not read SSH error: {e}"),
        }
    }

    pub async fn shutdown(&mut self) {
        for process in &mut self.children {
            process.kill_group();
        }
        for process in &mut self.children {
            let _ = process.child.wait().await;
        }
    }

    pub async fn stop(&mut self, index: usize) {
        self.children[index].kill_group();
        let _ = self.children[index].child.wait().await;
    }
}
