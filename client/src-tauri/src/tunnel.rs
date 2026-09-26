//! SSH tunnels to remote daemons (SPEC.md section 8.3).
//!
//! `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> user@host` forwards a free local port to
//! the daemon port on the remote host. The daemon stays bound to 127.0.0.1 on that host.
//!
//! - Key authentication only (`BatchMode=yes`): the app never shows a password prompt.
//! - A new host key is accepted and stored on the first connection (`StrictHostKeyChecking=accept-new`).
//!   A changed host key stops the connection.
//! - The tunnels stop when the app closes.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const OPEN_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    pub id: String,
    pub ssh_host: String,
    pub ssh_user: Option<String>,
    pub ssh_port: Option<u16>,
    pub identity_file: Option<String>,
    pub remote_port: u16,
}

struct Tunnel {
    child: Child,
    local_port: u16,
    spec: TunnelSpec,
}

#[derive(Clone, Default)]
pub struct Tunnels {
    inner: Arc<Mutex<HashMap<String, Tunnel>>>,
}

/// A value that goes to ssh as an argument. A value that starts with "-" would be an option,
/// for example "-oProxyCommand=...", which runs a command. Reject it.
fn safe_arg(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("The {label} is empty."));
    }
    if value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("The {label} is not valid: {value}"));
    }
    Ok(())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Cannot find a free port: {e}"))?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn is_alive(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

impl Tunnels {
    /// Opens a tunnel, or returns the tunnel that is already open for the same spec. Returns the local port.
    pub fn open(&self, spec: TunnelSpec) -> Result<u16, String> {
        safe_arg("SSH host", &spec.ssh_host)?;
        if let Some(user) = spec.ssh_user.as_deref().filter(|u| !u.is_empty()) {
            safe_arg("SSH user", user)?;
        }
        if let Some(file) = spec.identity_file.as_deref().filter(|f| !f.is_empty()) {
            if file.starts_with('-') {
                return Err(format!("The identity file is not valid: {file}"));
            }
        }

        {
            let mut map = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(existing) = map.get_mut(&spec.id) {
                if existing.spec == spec && is_alive(&mut existing.child) {
                    return Ok(existing.local_port);
                }
            }
            if let Some(mut old) = map.remove(&spec.id) {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        } // Do not hold the lock while ssh connects: close_all must not wait for it.

        let local_port = free_port()?;
        let mut cmd = Command::new("ssh");
        cmd.args([
            "-N",
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=accept-new",
            "-L",
        ]);
        cmd.arg(format!("127.0.0.1:{local_port}:127.0.0.1:{}", spec.remote_port));
        if let Some(port) = spec.ssh_port {
            cmd.args(["-p", &port.to_string()]);
        }
        if let Some(file) = spec.identity_file.as_deref().filter(|f| !f.is_empty()) {
            cmd.arg("-i").arg(file);
        }
        let target = match spec.ssh_user.as_deref().filter(|u| !u.is_empty()) {
            Some(user) => format!("{user}@{}", spec.ssh_host),
            None => spec.ssh_host.clone(),
        };
        // "--" ends the options: the target can never be an option.
        cmd.arg("--").arg(target);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| format!("Cannot start ssh. Is the OpenSSH client installed? {e}"))?;
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(mut pipe) = child.stderr.take() {
            let buffer = stderr.clone();
            std::thread::spawn(move || {
                let mut chunk = [0u8; 1024];
                while let Ok(n) = pipe.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut b) = buffer.lock() {
                        b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    }
                }
            });
        }

        let addr: SocketAddr = ([127, 0, 0, 1], local_port).into();
        let deadline = Instant::now() + OPEN_TIMEOUT;
        loop {
            if !is_alive(&mut child) {
                std::thread::sleep(Duration::from_millis(200)); // Let the reader collect the message.
                let message = stderr.lock().map(|s| s.trim().to_string()).unwrap_or_default();
                return Err(if message.is_empty() {
                    "ssh stopped before the tunnel was open.".into()
                } else {
                    format!("ssh failed: {message}")
                });
            }
            if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                break;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err(format!("The tunnel was not open after {} seconds.", OPEN_TIMEOUT.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(mut other) = map.insert(spec.id.clone(), Tunnel { child, local_port, spec }) {
            let _ = other.child.kill();
            let _ = other.child.wait();
        }
        Ok(local_port)
    }

    pub fn close(&self, id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            if let Some(mut t) = map.remove(id) {
                let _ = t.child.kill();
                let _ = t.child.wait();
            }
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut map) = self.inner.lock() {
            for (_, mut t) in map.drain() {
                let _ = t.child.kill();
                let _ = t.child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_values_that_ssh_reads_as_options() {
        assert!(safe_arg("SSH host", "-oProxyCommand=calc").is_err());
        assert!(safe_arg("SSH host", "host name").is_err());
        assert!(safe_arg("SSH host", "").is_err());
        assert!(safe_arg("SSH host", "build-box.tailnet.ts.net").is_ok());
        assert!(safe_arg("SSH user", "drew").is_ok());
    }

    #[test]
    fn open_rejects_a_bad_host_before_it_starts_ssh() {
        let tunnels = Tunnels::default();
        let spec = TunnelSpec {
            id: "t".into(),
            ssh_host: "-oProxyCommand=calc".into(),
            ssh_user: None,
            ssh_port: None,
            identity_file: None,
            remote_port: 8765,
        };
        assert!(tunnels.open(spec).unwrap_err().contains("not valid"));
    }

    #[test]
    fn a_failed_login_returns_the_ssh_message() {
        // Port 1 on this computer has no SSH server, so ssh stops at once.
        let tunnels = Tunnels::default();
        let spec = TunnelSpec {
            id: "t".into(),
            ssh_host: "127.0.0.1".into(),
            ssh_user: Some("nobody".into()),
            ssh_port: Some(1),
            identity_file: None,
            remote_port: 8765,
        };
        let err = tunnels.open(spec).unwrap_err();
        assert!(err.starts_with("ssh failed") || err.starts_with("ssh stopped"), "{err}");
    }
}
