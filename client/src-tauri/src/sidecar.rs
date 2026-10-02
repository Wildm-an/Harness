//! Starts and stops the local daemon (SPEC.md section 8.2).
//!
//! - The daemon listens on 127.0.0.1 with a random port.
//! - The client makes a random token for each start and gives it in `HARNESS_TOKEN`.
//! - The daemon prints one JSON line with the port when it is ready.
//! - The daemon stops when its stdin closes. Thus it also stops if this app crashes.
//!
//! The daemon command:
//! 1. `HARNESS_DAEMON` environment variable: a path to a daemon executable.
//! 2. The bundled sidecar: `harness-daemon/harness-daemon` in the resource folder of the app. The
//!    installers put the folder there (`bundle.resources` in `tauri.bundle.json`). It is a PyInstaller
//!    "onedir" folder: a onefile executable unpacked all its files at each start (about 4 seconds).
//!    The onefile `harness-daemon` next to the app executable (0.1.26 and before) is the fallback.
//! 3. Development layout: `<repo>/daemon/.venv` with `python -m harness_daemon`.
//!
//! The development daemon writes its log to the terminal. The other daemons write it to
//! `~/.harness/logs/daemon.log` (the log of the previous start is `daemon.log.1`).

use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
// Longer than the shutdown grace of the daemon (5 seconds), so that it can stop its servers.
const STOP_TIMEOUT: Duration = Duration::from_secs(6);
const SIDECAR_NAME: &str = if cfg!(windows) { "harness-daemon.exe" } else { "harness-daemon" };

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
    resource_dir: Arc<Mutex<Option<PathBuf>>>, // The resource folder of the app: it has the bundled daemon.
}

impl Sidecar {
    /// The resource folder of the app (`app.path().resource_dir()`). Call it before `ensure`.
    pub fn set_resource_dir(&self, dir: Option<PathBuf>) {
        if let Ok(mut guard) = self.resource_dir.lock() {
            *guard = dir;
        }
    }

    /// Returns the running daemon, or starts a new daemon. Blocks until the daemon is ready.
    pub fn ensure(&self) -> Result<DaemonInfo, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(running) = guard.as_mut() {
            if matches!(running.child.try_wait(), Ok(None)) {
                return Ok(running.info.clone());
            }
        }
        *guard = None;
        let resource_dir = self.resource_dir.lock().ok().and_then(|dir| dir.clone());
        let running = spawn_daemon(resource_dir.as_deref())?;
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

/// The daemon command, and true if the daemon log goes to the terminal.
fn daemon_command(resource_dir: Option<&Path>) -> Result<(Command, bool), String> {
    if let Ok(path) = std::env::var("HARNESS_DAEMON") {
        return Ok((Command::new(path), false));
    }
    if let Some(sidecar) = bundled_sidecar(resource_dir) {
        let mut cmd = Command::new(sidecar);
        // The daemon gets the project folder in each session. Its own folder does not matter.
        if let Some(home) = home_dir() {
            cmd.current_dir(home);
        }
        return Ok((cmd, false));
    }
    let daemon_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("daemon");
    let python = if cfg!(windows) {
        daemon_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        daemon_dir.join(".venv").join("bin").join("python")
    };
    if !python.exists() {
        return Err(format!(
            "The daemon was not found. The app looked for {SIDECAR_NAME} next to the app executable and for {}.              Set HARNESS_DAEMON to a daemon executable, or reinstall the app.",
            python.display()
        ));
    }
    let mut cmd = Command::new(python);
    cmd.args(["-m", "harness_daemon"]).current_dir(daemon_dir);
    Ok((cmd, true))
}

/// The sidecar that the installer put in the resource folder: `harness-daemon/harness-daemon`. Else the
/// onefile sidecar of an older install, next to the app executable (Contents/MacOS on macOS).
fn bundled_sidecar(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        let path = dir.join("harness-daemon").join(SIDECAR_NAME);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join(SIDECAR_NAME);
    path.is_file().then_some(path)
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The same folder as `harness_home()` in the daemon: `HARNESS_HOME`, or `~/.harness`.
fn harness_home() -> Option<PathBuf> {
    match std::env::var_os("HARNESS_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => home_dir().map(|home| home.join(".harness")),
    }
}

/// Opens a new daemon log. Keeps the log of the previous start as `daemon.log.1`.
fn open_log(logs: &Path) -> std::io::Result<(File, PathBuf)> {
    std::fs::create_dir_all(logs)?;
    let path = logs.join("daemon.log");
    if path.exists() {
        let _ = std::fs::rename(&path, logs.join("daemon.log.1"));
    }
    Ok((File::create(&path)?, path))
}

fn spawn_daemon(resource_dir: Option<&Path>) -> Result<Running, String> {
    let token = random_token()?;
    let (mut cmd, log_to_terminal) = daemon_command(resource_dir)?;
    cmd.args(["--host", "127.0.0.1", "--port", "0", "--exit-on-stdin-eof"])
        .env("HARNESS_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    // A release app on Windows has no console, so its stderr is not a valid handle.
    let log_hint = if log_to_terminal {
        cmd.stderr(Stdio::inherit());
        "See the daemon log in the terminal.".to_string()
    } else {
        let log = harness_home()
            .ok_or_else(|| "no home folder".to_string())
            .and_then(|home| open_log(&home.join("logs")).map_err(|e| e.to_string()));
        match log {
            Ok((file, path)) => {
                cmd.stderr(file);
                format!("See the daemon log: {}", path.display())
            }
            Err(e) => {
                cmd.stderr(Stdio::null());
                format!("The daemon log is not available: {e}.")
            }
        }
    };
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
            return Err(format!("The daemon stopped before it was ready. {log_hint}"));
        }
        Err(_) => {
            let _ = child.kill();
            return Err(format!("The daemon was not ready after {} seconds. {log_hint}", READY_TIMEOUT.as_secs()));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_log_keeps_the_previous_log() {
        let logs = std::env::temp_dir().join(format!("harness-log-test-{}", random_token().unwrap()));
        let (mut first, path) = open_log(&logs).unwrap();
        std::io::Write::write_all(&mut first, b"first start").unwrap();
        drop(first);
        let (second, again) = open_log(&logs).unwrap();
        assert_eq!(path, again);
        assert_eq!(std::fs::read_to_string(logs.join("daemon.log.1")).unwrap(), "first start");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        drop(second);
        let _ = std::fs::remove_dir_all(&logs);
    }
}
