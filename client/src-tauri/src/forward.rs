//! Port forwarding for servers on a remote daemon (SPEC.md section 8.6, remote mode).
//!
//! A server on a remote computer listens on that computer. For each server, the app listens
//! on a free local port. Each TCP connection to that port opens a WebSocket to the daemon
//! (`/forward`), and the daemon connects to the server port. The daemon forwards only the
//! ports of servers in launch.json.

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    pub daemon_host: String,
    pub daemon_port: u16,
    pub token: String,
    pub session_id: String,
    pub server: String,
}

struct Forward {
    spec: ForwardSpec,
    local_port: u16,
    task: JoinHandle<()>,
}

#[derive(Clone, Default)]
pub struct Forwards {
    inner: Arc<Mutex<HashMap<String, Forward>>>,
}

impl Forwards {
    /// Listens on a free local port for a server. Returns the port. The same spec reuses the listener.
    pub async fn open(&self, spec: ForwardSpec) -> Result<u16, String> {
        {
            let map = self.inner.lock().map_err(|e| e.to_string())?;
            if let Some(f) = map.get(&spec.server) {
                if f.spec == spec && !f.task.is_finished() {
                    return Ok(f.local_port);
                }
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Cannot listen on a local port: {e}"))?;
        let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let task_spec = spec.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let s = task_spec.clone();
                tokio::spawn(async move {
                    if let Err(e) = relay(stream, s).await {
                        eprintln!("[harness] port forward: {e}");
                    }
                });
            }
        });
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(old) = map.insert(spec.server.clone(), Forward { spec, local_port, task }) {
            old.task.abort();
        }
        Ok(local_port)
    }

    pub fn close_all(&self) {
        if let Ok(mut map) = self.inner.lock() {
            for (_, f) in map.drain() {
                f.task.abort();
            }
        }
    }
}

async fn relay(mut tcp: TcpStream, spec: ForwardSpec) -> Result<(), String> {
    let url = format!("ws://{}:{}/forward", spec.daemon_host, spec.daemon_port);
    let (ws, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| format!("Cannot reach the daemon: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    let auth = serde_json::json!({ "type": "auth", "token": spec.token }).to_string();
    let request = serde_json::json!({ "type": "forward", "session_id": spec.session_id, "server": spec.server }).to_string();
    sink.send(Message::Text(auth.into())).await.map_err(|e| e.to_string())?;
    sink.send(Message::Text(request.into())).await.map_err(|e| e.to_string())?;
    match stream.next().await {
        Some(Ok(Message::Text(text))) if text.contains("forward.ok") => {}
        Some(Ok(Message::Text(text))) => return Err(format!("The daemon refused the forward: {text}")),
        other => return Err(format!("The daemon closed the forward: {other:?}")),
    }

    let (mut tcp_read, mut tcp_write) = tcp.split();
    let to_daemon = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = tcp_read.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                let _ = sink.close().await;
                return Ok::<(), String>(());
            }
            sink.send(Message::Binary(buf[..n].to_vec().into())).await.map_err(|e| e.to_string())?;
        }
    };
    let to_browser = async {
        while let Some(message) = stream.next().await {
            match message.map_err(|e| e.to_string())? {
                Message::Binary(data) => tcp_write.write_all(&data).await.map_err(|e| e.to_string())?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = tcp_write.shutdown().await;
        Ok::<(), String>(())
    };
    // The connection ends when either side ends.
    tokio::select! {
        r = to_daemon => r,
        r = to_browser => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A fake daemon: it checks the auth and forward messages, replies forward.ok, then echoes bytes in upper case.
    async fn fake_daemon(expected_token: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let (mut sink, mut source) = ws.split();
                    let auth = source.next().await.unwrap().unwrap().into_text().unwrap();
                    let request = source.next().await.unwrap().unwrap().into_text().unwrap();
                    if !auth.contains(expected_token) || !request.contains("\"server\":\"web\"") {
                        let _ = sink.send(Message::Text("{\"type\":\"error\",\"message\":\"no\"}".into())).await;
                        return;
                    }
                    sink.send(Message::Text("{\"type\":\"forward.ok\"}".into())).await.unwrap();
                    while let Some(Ok(message)) = source.next().await {
                        if let Message::Binary(data) = message {
                            sink.send(Message::Binary(data.to_ascii_uppercase().into())).await.unwrap();
                        }
                    }
                });
            }
        });
        port
    }

    fn spec(daemon_port: u16, token: &str) -> ForwardSpec {
        ForwardSpec {
            daemon_host: "127.0.0.1".into(),
            daemon_port,
            token: token.into(),
            session_id: "s1".into(),
            server: "web".into(),
        }
    }

    #[tokio::test]
    async fn forwards_bytes_through_the_daemon() {
        let daemon = fake_daemon("good-token").await;
        let forwards = Forwards::default();
        let local = forwards.open(spec(daemon, "good-token")).await.unwrap();
        // The same spec reuses the listener.
        assert_eq!(forwards.open(spec(daemon, "good-token")).await.unwrap(), local);

        let mut tcp = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        tcp.write_all(b"hello server").await.unwrap();
        let mut buf = vec![0u8; 12];
        tcp.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"HELLO SERVER");
        forwards.close_all();
    }

    #[tokio::test]
    async fn a_refused_forward_closes_the_connection() {
        let daemon = fake_daemon("good-token").await;
        let forwards = Forwards::default();
        let local = forwards.open(spec(daemon, "bad-token")).await.unwrap();
        let mut tcp = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        let _ = tcp.write_all(b"x").await;
        let mut buf = [0u8; 1];
        // The relay stops: the read ends with no data.
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), tcp.read(&mut buf)).await.unwrap().unwrap_or(0);
        assert_eq!(n, 0);
        forwards.close_all();
    }
}
