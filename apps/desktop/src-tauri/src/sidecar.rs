use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConnection {
    pub protocol: String,
    pub port: u16,
    pub base_url: String,
    pub human_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

#[derive(Clone, Default)]
pub struct SidecarManager {
    inner: Arc<Mutex<SidecarState>>,
    start_lock: Arc<Mutex<()>>,
}

#[derive(Default)]
struct SidecarState {
    connection: Option<DaemonConnection>,
    child: Option<CommandChild>,
}

fn spawn_sidecar_command(
    app: &AppHandle,
) -> Result<
    (
        tauri::async_runtime::Receiver<CommandEvent>,
        CommandChild,
    ),
    String,
> {
    let args = ["desktop-daemon", "--listen", "127.0.0.1:0"];
    if let Ok(sidecar) = app.shell().sidecar("aegis-os") {
        match sidecar.args(args).spawn() {
            Ok(pair) => return Ok(pair),
            Err(bundled_err) => {
                #[cfg(not(debug_assertions))]
                return Err(format!("failed spawning bundled aegis-os desktop-daemon: {bundled_err}"));
                #[cfg(debug_assertions)]
                {
                    let dev_bin = std::env::var("AEGIS_OS_BIN")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| "aegis-os".to_string());
                    return app
                        .shell()
                        .command(&dev_bin)
                        .args(args)
                        .spawn()
                        .map_err(|path_err| {
                            format!(
                                "failed spawning bundled sidecar ({bundled_err}) and dev PATH fallback '{dev_bin}' ({path_err})"
                            )
                        });
                }
            }
        }
    }

    #[cfg(debug_assertions)]
    {
        let dev_bin = std::env::var("AEGIS_OS_BIN")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "aegis-os".to_string());
        app.shell()
            .command(&dev_bin)
            .args(args)
            .spawn()
            .map_err(|e| format!("failed spawning dev aegis-os sidecar '{dev_bin}': {e}"))
    }
    #[cfg(not(debug_assertions))]
    {
        Err("failed locating bundled aegis-os sidecar".to_string())
    }
}

impl SidecarManager {
    /// Spawns the bundled `aegis-os desktop-daemon` sidecar on `127.0.0.1:0` and waits
    /// on a background worker thread until the 1-line JSON handshake is received on stdout.
    /// Concurrent callers serialize via `start_lock` so warmup and WebView boot never spawn duplicates.
    pub fn start(&self, app: &AppHandle) -> Result<DaemonConnection, String> {
        let _start_guard = self
            .start_lock
            .lock()
            .map_err(|e| format!("sidecar start lock poisoned: {e}"))?;

        {
            let guard = self.inner.lock().map_err(|e| format!("sidecar lock poisoned: {e}"))?;
            if let Some(conn) = &guard.connection {
                return Ok(conn.clone());
            }
        }

        let (mut rx, child) = spawn_sidecar_command(app)?;

        let (tx, conn_rx) = std::sync::mpsc::channel::<Result<DaemonConnection, String>>();
        let state_ref = Arc::clone(&self.inner);

        tauri::async_runtime::spawn(async move {
            let mut sent = false;
            let mut stderr_tail: Vec<String> = Vec::new();

            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes);
                        for part in line.lines() {
                            let trimmed = part.trim();
                            if trimmed.starts_with('{') && !sent {
                                match serde_json::from_str::<DaemonConnection>(trimmed) {
                                    Ok(conn) => {
                                        if let Ok(mut guard) = state_ref.lock() {
                                            guard.connection = Some(conn.clone());
                                        }
                                        let _ = tx.send(Ok(conn));
                                        sent = true;
                                    }
                                    Err(e) => {
                                        let _ = tx.send(Err(format!("invalid daemon handshake JSON: {e}")));
                                        sent = true;
                                    }
                                }
                            }
                        }
                    }
                    CommandEvent::Stderr(err_bytes) => {
                        let text = String::from_utf8_lossy(&err_bytes);
                        for line in text.lines() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                if stderr_tail.len() >= 12 {
                                    stderr_tail.remove(0);
                                }
                                stderr_tail.push(trimmed.to_string());
                            }
                        }
                    }
                    CommandEvent::Error(err) => {
                        if !sent {
                            let _ = tx.send(Err(format!("daemon error: {err}")));
                            sent = true;
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        if let Ok(mut guard) = state_ref.lock() {
                            guard.child = None;
                            guard.connection = None;
                        }
                        if !sent {
                            let tail = if stderr_tail.is_empty() {
                                String::new()
                            } else {
                                format!(": {}", stderr_tail.join(" | "))
                            };
                            let _ = tx.send(Err(format!(
                                "aegis-os desktop-daemon exited before handshake (code {:?}){tail}",
                                payload.code
                            )));
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        {
            let mut guard = self.inner.lock().map_err(|e| format!("sidecar lock poisoned: {e}"))?;
            guard.child = Some(child);
        }

        match conn_rx.recv_timeout(std::time::Duration::from_secs(8)) {
            Ok(res) => {
                if res.is_err() {
                    self.shutdown();
                }
                res
            }
            Err(e) => {
                self.shutdown();
                Err(format!("timed out waiting for desktop-daemon handshake: {e}"))
            }
        }
    }

    pub fn get_connection(&self) -> Option<DaemonConnection> {
        self.inner.lock().ok().and_then(|g| g.connection.clone())
    }

    /// Gracefully stops the sidecar child process (called on app exit or pre-update).
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(child) = guard.child.take() {
                let _ = child.kill();
            }
            guard.connection = None;
        }
    }

    /// Proxies authenticated HTTP calls from WebView to `127.0.0.1:{port}` over direct TCP,
    /// bypassing WebKitGTK cross-origin CORS preflight restrictions cleanly.
    pub fn http_request(
        &self,
        app: &AppHandle,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<DaemonHttpResponse, String> {
        let method_upper = method.trim().to_ascii_uppercase();
        if !matches!(
            method_upper.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            return Err(format!("unsupported HTTP method: {method}"));
        }
        if !path.starts_with('/') || path.contains('\r') || path.contains('\n') {
            return Err("invalid daemon request path".to_string());
        }

        let mut conn = match self.get_connection() {
            Some(c) => c,
            None => self.start(app)?,
        };

        for attempt in 0..2 {
            match send_loopback_http(&conn, &method_upper, path, body) {
                Ok(resp) => return Ok(resp),
                Err(err)
                    if attempt == 0
                        && err.kind() == std::io::ErrorKind::ConnectionRefused =>
                {
                    self.shutdown();
                    conn = self.start(app)?;
                }
                Err(err) => {
                    return Err(format!(
                        "daemon HTTP request {method_upper} {path} failed: {err}"
                    ));
                }
            }
        }

        Err(format!(
            "daemon HTTP request {method_upper} {path} failed after sidecar restart"
        ))
    }
}

fn send_loopback_http(
    conn: &DaemonConnection,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> std::io::Result<DaemonHttpResponse> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), conn.port);
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;

    let payload = body.unwrap_or("");
    let has_body = body.is_some();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\n",
        conn.port, conn.human_token
    );
    if has_body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    req.push_str("\r\n");
    if has_body {
        req.push_str(payload);
    }

    stream.write_all(req.as_bytes())?;
    stream.flush()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    parse_http_response(&raw)
        .map_err(|msg| std::io::Error::new(std::io::ErrorKind::InvalidData, msg))
}

fn parse_http_response(raw: &[u8]) -> Result<DaemonHttpResponse, String> {
    let (head_end, sep_len) = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4))
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)))
        .ok_or_else(|| "malformed HTTP response from daemon (missing header terminator)".to_string())?;

    let header_str = std::str::from_utf8(&raw[..head_end])
        .map_err(|e| format!("invalid UTF-8 headers from daemon: {e}"))?;
    let mut lines = header_str.lines();
    let status_line = lines
        .next()
        .ok_or_else(|| "empty HTTP status line from daemon".to_string())?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("unparseable HTTP status line: {status_line}"))?;

    let mut content_type = "application/json".to_string();
    let mut is_chunked = false;
    for line in lines {
        if let Some((name, val)) = line.split_once(':') {
            let key = name.trim().to_ascii_lowercase();
            let val = val.trim();
            if key == "content-type" {
                content_type = val.to_string();
            } else if key == "transfer-encoding" && val.to_ascii_lowercase().contains("chunked") {
                is_chunked = true;
            }
        }
    }

    let raw_body = &raw[head_end + sep_len..];
    let decoded = if is_chunked {
        decode_chunked(raw_body)
    } else {
        raw_body.to_vec()
    };
    let body = String::from_utf8_lossy(&decoded).to_string();

    Ok(DaemonHttpResponse {
        status,
        content_type,
        body,
    })
}

fn decode_chunked(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let Some(rel_end) = data[i..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_line = String::from_utf8_lossy(&data[i..i + rel_end]);
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(chunk_len) = usize::from_str_radix(size_hex, 16) else {
            break;
        };
        i += rel_end + 2;
        if chunk_len == 0 {
            break;
        }
        let end = i.saturating_add(chunk_len).min(data.len());
        out.extend_from_slice(&data[i..end]);
        i = end.saturating_add(2);
    }
    out
}
