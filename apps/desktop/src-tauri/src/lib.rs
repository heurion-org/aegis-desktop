mod sidecar;

use sidecar::{DaemonConnection, SidecarManager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn get_daemon_connection(
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<DaemonConnection, String> {
    if let Some(existing) = sidecar.get_connection() {
        return Ok(existing);
    }
    let manager = sidecar.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(&app))
        .await
        .map_err(|e| format!("sidecar startup task aborted: {e}"))?
}

#[tauri::command]
async fn pick_workspace_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked.map(|p| p.to_string()));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
}

#[tauri::command]
fn shutdown_daemon(sidecar: State<'_, SidecarManager>) {
    sidecar.shutdown();
}

pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Avoid blank WebKitGTK windows on mixed Wayland/NVIDIA setups.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let sidecar = SidecarManager::default();

    let app = tauri::Builder::default()
        .manage(sidecar)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_daemon_connection,
            pick_workspace_folder,
            shutdown_daemon
        ])
        .setup(|app| {
            let default_icon = app.default_window_icon().cloned();
            if let (Some(win), Some(icon)) = (app.get_webview_window("main"), default_icon.clone()) {
                let _ = win.set_icon(icon);
            }

            if let Ok(show_item) =
                MenuItem::with_id(app, "show", "Show Aegis Desktop", true, None::<&str>)
            {
                if let Ok(quit_item) = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>) {
                    if let Ok(menu) = Menu::with_items(app, &[&show_item, &quit_item]) {
                        let mut tray_builder = TrayIconBuilder::new().menu(&menu);
                        if let Some(icon) = default_icon {
                            tray_builder = tray_builder.icon(icon);
                        }
                        if let Err(err) = tray_builder
                            .on_menu_event(|app_handle, event| match event.id.as_ref() {
                                "show" => {
                                    if let Some(win) = app_handle.get_webview_window("main") {
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                    }
                                }
                                "quit" => {
                                    app_handle.state::<SidecarManager>().shutdown();
                                    app_handle.exit(0);
                                }
                                _ => {}
                            })
                            .build(app)
                        {
                            eprintln!("[aegis-desktop] warning: tray initialization skipped ({err})");
                        }
                    }
                }
            }

            // Warm up sidecar off the UI/GTK main thread so window creation is instantaneous.
            let app_handle = app.handle().clone();
            let manager = app.state::<SidecarManager>().inner().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(err) = manager.start(&app_handle) {
                    eprintln!("[aegis-desktop] warning: deferred sidecar startup ({err})");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Aegis Desktop Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            app_handle.state::<SidecarManager>().shutdown();
        }
    });
}
