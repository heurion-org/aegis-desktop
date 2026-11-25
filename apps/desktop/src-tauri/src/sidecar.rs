use std::sync::{Arc, Mutex};

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
}
