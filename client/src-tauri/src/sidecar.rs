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
//!
//! The server daemon (Settings > Computers, the play button) is a second daemon of the same command,
//! for other computers. It listens on 127.0.0.1 with a fixed port, and it uses the token file
//! (`~/.harness/daemon-token`), so the token stays the same after a restart. Its ready line has the
//! token. It also stops when its stdin closes: it runs only while this app runs. Its log is
//! `~/.harness/logs/server-daemon.log`.

use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// A client of the server daemon: a computer that is connected now (`clients.py` of the daemon).
#[derive(Clone, Serialize, serde::Deserialize, Debug, PartialEq)]
pub struct ClientConnection {
    pub id: u64,
    pub peer: Option<String>, // "address:port". Through an SSH tunnel it is 127.0.0.1.
    pub name: Option<String>, // The computer name that the client sends. Null for an older client.
    pub app: Option<String>,  // The app version of the client.
    pub since: u64,           // Milliseconds since 1970.
}

/// The server daemon and its clients, for the Computers page.
#[derive(Clone, Serialize)]
pub struct ServerInfo {
    pub host: String,
    pub hosts: Vec<String>, // All the addresses that the daemon listens on: 127.0.0.1, and the Tailscale address.
    pub port: u16,
    pub token: String,
    pub connections: Vec<ClientConnection>,
}

/// Called after a client connects or disconnects, and after the server daemon stops by itself.
pub type OnChange = Arc<dyn Fn() + Send + Sync>;

struct Running {
    child: Child,
    info: DaemonInfo,
    hosts: Vec<String>,
    clients: Arc<Mutex<Vec<ClientConnection>>>,
    ended: Arc<AtomicBool>, // The stdout of the daemon closed: the daemon stops.
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
        let running = spawn(resource_dir.as_deref(), Mode::Local, None)?;
        let info = running.info.clone();
        *guard = Some(running);
        Ok(info)
    }

    /// Closes the stdin of the daemon, so that it stops its turns and servers. Kills it after a timeout.
    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else { return };
        if let Some(running) = guard.take() {
            stop_running(running);
        }
    }
}

/// The server daemon: a daemon on a fixed port for other computers (Settings > Computers).
#[derive(Clone, Default)]
pub struct ServerDaemon {
    inner: Arc<Mutex<Option<Running>>>,
}

impl ServerDaemon {
    /// The running server daemon and its clients, or None.
    pub fn status(&self) -> Option<ServerInfo> {
        let mut guard = self.inner.lock().ok()?;
        let running = guard.as_mut()?;
        if !running.ended.load(Ordering::SeqCst) && matches!(running.child.try_wait(), Ok(None)) {
            return Some(server_info(running));
        }
        *guard = None;
        None
    }

    /// Starts the server daemon on `port`, or returns the one that runs. Blocks until it is ready.
    /// `new_token`: stop the daemon that runs, and start it with a new token (`--new-token`). The
    /// clients of the old token lose the connection, and they cannot connect again.
    /// `also_host`: one more address to listen on, for example the Tailscale address of this computer.
    pub fn start(
        &self,
        resource_dir: Option<&Path>,
        port: u16,
        new_token: bool,
        also_host: Option<String>,
        on_change: OnChange,
    ) -> Result<ServerInfo, String> {
        if new_token {
            self.stop();
        } else if let Some(info) = self.status() {
            return Ok(info);
        }
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let mode = Mode::Server { port, new_token, also_host: also_host.as_deref() };
        let running = spawn(resource_dir, mode, Some(on_change))?;
        let info = server_info(&running);
        *guard = Some(running);
        Ok(info)
    }

    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else { return };
        if let Some(running) = guard.take() {
            stop_running(running);
        }
    }
}

fn stop_running(mut running: Running) {
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

fn server_info(running: &Running) -> ServerInfo {
    let connections = running.clients.lock().map(|c| c.clone()).unwrap_or_default();
    ServerInfo {
        host: running.info.host.clone(),
        hosts: running.hosts.clone(),
        port: running.info.port,
        token: running.info.token.clone(),
        connections,
    }
}

/// The local daemon of this app, or the server daemon on a fixed port.
#[derive(Clone, Copy)]
enum Mode<'a> {
    Local,
    Server { port: u16, new_token: bool, also_host: Option<&'a str> },
}

/// True for an address of the Tailscale range (100.64.0.0/10).
fn is_tailscale(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

/// The Tailscale address of this computer, or None. The route to the Tailscale DNS address
/// (100.100.100.100) goes through the Tailscale interface: a UDP socket that "connects" to it gets
/// the local address of that interface. It sends no packet. Else the `tailscale ip -4` command.
pub fn tailscale_address() -> Option<String> {
    use std::net::{IpAddr, UdpSocket};
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("100.100.100.100:53").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if let IpAddr::V4(ip) = addr.ip() {
                    if is_tailscale(ip) {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    let mut cmd = Command::new("tailscale");
    cmd.args(["ip", "-4"]).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<std::net::Ipv4Addr>().ok())
        .find(|ip| is_tailscale(*ip))
        .map(|ip| ip.to_string())
}

/// Applies one stdout line of the server daemon (`clients.py`) to the list. True if the list changed.
fn apply_client_event(clients: &mut Vec<ClientConnection>, line: &str) -> bool {
    let Ok(event) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return false };
    match event.get("event").and_then(|e| e.as_str()) {
        Some("connection.open") => match serde_json::from_value::<ClientConnection>(event) {
            Ok(client) => {
                clients.retain(|c| c.id != client.id);
                clients.push(client);
                true
            }
            Err(_) => false,
        },
        Some("connection.close") => {
            let Some(id) = event.get("id").and_then(|i| i.as_u64()) else { return false };
            let before = clients.len();
            clients.retain(|c| c.id != id);
            clients.len() != before
        }
        _ => false,
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

/// The program of the daemon, for the firewall rule (firewall.rs). None for the development daemon
/// (`python -m harness_daemon`).
pub fn daemon_program(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("HARNESS_DAEMON") {
        return Some(PathBuf::from(path));
    }
    bundled_sidecar(resource_dir)
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

/// Opens a new daemon log `{name}.log`. Keeps the log of the previous start as `{name}.log.1`.
fn open_log(logs: &Path, name: &str) -> std::io::Result<(File, PathBuf)> {
    std::fs::create_dir_all(logs)?;
    let path = logs.join(format!("{name}.log"));
    if path.exists() {
        let _ = std::fs::rename(&path, logs.join(format!("{name}.log.1")));
    }
    Ok((File::create(&path)?, path))
}

fn spawn(resource_dir: Option<&Path>, mode: Mode<'_>, on_change: Option<OnChange>) -> Result<Running, String> {
    let (mut cmd, log_to_terminal) = daemon_command(resource_dir)?;
    let token = match mode {
        Mode::Local => {
            let token = random_token()?;
            // --prefer-port: the same port at each start when it is free, so the fire URL of a routine
            // API trigger stays the same. Else the daemon takes a random port.
            cmd.args(["--host", "127.0.0.1", "--port", "0", "--prefer-port", "47615"]).env("HARNESS_TOKEN", &token);
            Some(token)
        }
        Mode::Server { port, new_token, also_host } => {
            // No HARNESS_TOKEN: the daemon uses the token file, and the ready line has the token.
            cmd.args(["--host", "127.0.0.1", "--port", &port.to_string(), "--report-connections"])
                .env_remove("HARNESS_TOKEN");
            if let Some(host) = also_host {
                cmd.args(["--also-host", host]);
            }
            if new_token {
                cmd.arg("--new-token");
            }
            None
        }
    };
    cmd.arg("--exit-on-stdin-eof").stdin(Stdio::piped()).stdout(Stdio::piped());
    let log_name = match mode {
        Mode::Local => "daemon",
        Mode::Server { .. } => "server-daemon",
    };
    // A release app on Windows has no console, so its stderr is not a valid handle.
    let log_hint = if log_to_terminal {
        cmd.stderr(Stdio::inherit());
        "See the daemon log in the terminal.".to_string()
    } else {
        let log = harness_home()
            .ok_or_else(|| "no home folder".to_string())
            .and_then(|home| open_log(&home.join("logs"), log_name).map_err(|e| e.to_string()));
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
    let clients: Arc<Mutex<Vec<ClientConnection>>> = Arc::default();
    let ended = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    {
        let clients = clients.clone();
        let ended = ended.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let result = reader.read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
            // Keep the pipe empty, so that the daemon never blocks on a write. The server daemon
            // reports its clients on stdout.
            match on_change {
                None => {
                    let mut sink = Vec::new();
                    let _ = reader.read_to_end(&mut sink);
                }
                Some(on_change) => {
                    let mut line = String::new();
                    while matches!(reader.read_line(&mut line), Ok(n) if n > 0) {
                        let changed = clients.lock().map(|mut c| apply_client_event(&mut c, &line)).unwrap_or(false);
                        if changed {
                            on_change();
                        }
                        line.clear();
                    }
                    ended.store(true, Ordering::SeqCst);
                    if let Ok(mut c) = clients.lock() {
                        c.clear();
                    }
                    on_change();
                }
            }
        });
    }

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
    let token = match token {
        Some(token) => token,
        // A daemon that uses the token file puts the token in its ready line.
        None => match ready.get("token").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
            Some(token) => token.to_string(),
            None => {
                drop(child.stdin.take());
                let _ = child.kill();
                return Err("The daemon ready line has no token.".into());
            }
        },
    };
    let hosts = ready
        .get("hosts")
        .and_then(|h| h.as_array())
        .map(|h| h.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_else(|| vec!["127.0.0.1".to_string()]);
    Ok(Running {
        child,
        info: DaemonInfo { host: "127.0.0.1".into(), port, token },
        hosts,
        clients,
        ended,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailscale_range() {
        assert!(is_tailscale("100.64.0.1".parse().unwrap()));
        assert!(is_tailscale("100.127.255.254".parse().unwrap()));
        assert!(!is_tailscale("100.128.0.1".parse().unwrap()));
        assert!(!is_tailscale("100.63.0.1".parse().unwrap()));
        assert!(!is_tailscale("192.168.1.5".parse().unwrap()));
    }

    #[test]
    fn client_events_update_the_list() {
        let mut clients = Vec::new();
        let open = r#"{"event": "connection.open", "id": 1, "peer": "127.0.0.1:5000", "name": "laptop", "app": "0.1.73", "since": 1700000000000}"#;
        assert!(apply_client_event(&mut clients, open));
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].name.as_deref(), Some("laptop"));
        let old = r#"{"event": "connection.open", "id": 2, "peer": null, "name": null, "app": null, "since": 1}"#;
        assert!(apply_client_event(&mut clients, old));
        assert!(!apply_client_event(&mut clients, "not json"));
        assert!(!apply_client_event(&mut clients, r#"{"event": "ready", "port": 8765}"#));
        assert!(apply_client_event(&mut clients, r#"{"event": "connection.close", "id": 1}"#));
        assert!(!apply_client_event(&mut clients, r#"{"event": "connection.close", "id": 1}"#));
        assert_eq!(clients.iter().map(|c| c.id).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn a_new_log_keeps_the_previous_log() {
        let logs = std::env::temp_dir().join(format!("harness-log-test-{}", random_token().unwrap()));
        let (mut first, path) = open_log(&logs, "daemon").unwrap();
        std::io::Write::write_all(&mut first, b"first start").unwrap();
        drop(first);
        let (second, again) = open_log(&logs, "daemon").unwrap();
        assert_eq!(path, again);
        assert_eq!(std::fs::read_to_string(logs.join("daemon.log.1")).unwrap(), "first start");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        drop(second);
        let _ = std::fs::remove_dir_all(&logs);
    }
}
