mod sidecar;

use sidecar::{DaemonConnection, SidecarManager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn get_daemon_connection(
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<DaemonConnection, String> {
    if let Some(existing) = sidecar.get_connection() {
        return Ok(existing);
    }
    sidecar.start(&app)
}

#[tauri::command]
fn pick_workspace_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
fn shutdown_daemon(sidecar: State<'_, SidecarManager>) {
    sidecar.shutdown();
}

pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Avoid blank WebKitGTK windows on mixed Wayland/NVIDIA Linux setups.
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
            let show_item = MenuItem::with_id(app, "show", "Show Aegis Desktop", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
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
                .build(app)?;

            let manager = app.state::<SidecarManager>();
            if let Err(err) = manager.start(app.handle()) {
                eprintln!("[aegis-desktop] warning: deferred sidecar startup ({err})");
            }
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
