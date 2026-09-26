//! Starts and stops the local daemon (SPEC.md section 8.2).
//!
//! - The daemon listens on 127.0.0.1 with a random port.
//! - The client makes a random token for each start and gives it in `HARNESS_TOKEN`.
//! - The daemon prints one JSON line with the port when it is ready.
//! - The daemon stops when its stdin closes. Thus it also stops if this app crashes.
//!
//! The daemon command:
//! 1. `HARNESS_DAEMON` environment variable: a path to a daemon executable.
//! 2. Development layout: `<repo>/daemon/.venv` with `python -m harness_daemon`.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Serialize)]
pub struct DaemonInfo {
    pub host: String,
    pub port: u16,
    pub token: String,
}

struct Running {
    child: Child,
    info: DaemonInfo,
}

#[derive(Clone, Default)]
pub struct Sidecar {
    inner: Arc<Mutex<Option<Running>>>,
}

impl Sidecar {
    /// Returns the running daemon, or starts a new daemon. Blocks until the daemon is ready.
    pub fn ensure(&self) -> Result<DaemonInfo, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(running) = guard.as_mut() {
            if matches!(running.child.try_wait(), Ok(None)) {
                return Ok(running.info.clone());
            }
        }
        *guard = None;
        let running = spawn_daemon()?;
        let info = running.info.clone();
        *guard = Some(running);
        Ok(info)
    }

    /// Closes the stdin of the daemon, so that it stops its turns and servers. Kills it after a timeout.
    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else { return };
        let Some(mut running) = guard.take() else { return };
        drop(running.child.stdin.take());
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if !matches!(running.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Cannot make a token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn daemon_command() -> Result<Command, String> {
    if let Ok(path) = std::env::var("HARNESS_DAEMON") {
        return Ok(Command::new(path));
    }
    let daemon_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("daemon");
    let python = if cfg!(windows) {
        daemon_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        daemon_dir.join(".venv").join("bin").join("python")
    };
    if !python.exists() {
        return Err(format!(
            "The daemon was not found. Set HARNESS_DAEMON, or create the virtual environment at {}.",
            python.display()
        ));
    }
    let mut cmd = Command::new(python);
    cmd.args(["-m", "harness_daemon"]).current_dir(daemon_dir);
    Ok(cmd)
}

fn spawn_daemon() -> Result<Running, String> {
    let token = random_token()?;
    let mut cmd = daemon_command()?;
    cmd.args(["--host", "127.0.0.1", "--port", "0", "--exit-on-stdin-eof"])
        .env("HARNESS_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Cannot start the daemon: {e}"))?;
    let stdout = child.stdout.take().ok_or("The daemon has no stdout.")?;

    // Read the ready line on a thread, so that a timeout is possible.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
        // Keep the pipe empty, so that the daemon never blocks on a write.
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink);
    });

    let line = match rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(line)) if !line.trim().is_empty() => line,
        Ok(Ok(_)) | Ok(Err(_)) => {
            let _ = child.kill();
            return Err("The daemon stopped before it was ready. See the daemon log.".into());
        }
        Err(_) => {
            let _ = child.kill();
            return Err(format!("The daemon was not ready after {} seconds.", READY_TIMEOUT.as_secs()));
        }
    };

    let ready: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("The daemon ready line is not JSON: {e}"))?;
    let port = ready
        .get("port")
        .and_then(|p| p.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .ok_or("The daemon ready line has no port.")?;
    Ok(Running {
        child,
        info: DaemonInfo { host: "127.0.0.1".into(), port, token },
    })
}
