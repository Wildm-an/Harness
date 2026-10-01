mod browser;
mod forward;
mod secrets;
mod sidecar;
mod tunnel;

use browser::Bounds;
use forward::{ForwardSpec, Forwards};
use sidecar::{DaemonInfo, Sidecar};
use tauri::AppHandle;
use tunnel::{TunnelSpec, Tunnels};
use tauri::{Manager, RunEvent, State};
use tauri_plugin_window_state::StateFlags;

/// Returns the address and token of the local daemon. Starts the daemon if it does not run.
#[tauri::command]
async fn daemon_info(state: State<'_, Sidecar>) -> Result<DaemonInfo, String> {
    let sidecar = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sidecar.ensure())
        .await
        .map_err(|e| e.to_string())?
}

/// Stops the local daemon and starts a new one with a new port and token.
#[tauri::command]
async fn restart_daemon(state: State<'_, Sidecar>) -> Result<DaemonInfo, String> {
    let sidecar = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sidecar.stop();
        sidecar.ensure()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens an SSH tunnel to a remote daemon. Returns the local port.
#[tauri::command]
async fn tunnel_open(state: State<'_, Tunnels>, spec: TunnelSpec) -> Result<u16, String> {
    let tunnels = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tunnels.open(spec))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn tunnel_close(state: State<'_, Tunnels>, id: String) {
    state.close(&id);
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    secrets::get(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    secrets::delete(&key)
}

/// Listens on a local port for a server on a remote daemon. Returns the port.
#[tauri::command]
async fn forward_open(state: State<'_, Forwards>, spec: ForwardSpec) -> Result<u16, String> {
    state.inner().clone().open(spec).await
}

#[tauri::command]
fn forward_close_all(state: State<'_, Forwards>) {
    state.close_all();
}

// The browser commands are async: a synchronous command that makes a webview deadlocks on Windows.
// "id" is the tab of the Browser pane. Each tab has its own webview.
#[tauri::command]
async fn browser_open(app: AppHandle, id: String, url: String, bounds: Bounds) -> Result<(), String> {
    browser::open(&app, &id, &url, bounds)
}

#[tauri::command]
async fn browser_bounds(app: AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    browser::set_bounds(&app, &id, bounds)
}

#[tauri::command]
async fn browser_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    browser::set_visible(&app, &id, visible)
}

#[tauri::command]
async fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    browser::navigate(&app, &id, &url)
}

#[tauri::command]
async fn browser_history(app: AppHandle, id: String, action: String) -> Result<(), String> {
    browser::history(&app, &id, &action)
}

#[tauri::command]
async fn browser_devtools(app: AppHandle, id: String) -> Result<(), String> {
    browser::devtools(&app, &id)
}

#[tauri::command]
async fn browser_clear_data(app: AppHandle, id: String) -> Result<(), String> {
    browser::clear_data(&app, &id)
}

#[tauri::command]
async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    browser::close(&app, &id)
}

#[tauri::command]
async fn browser_close_all(app: AppHandle) -> Result<(), String> {
    browser::close_all(&app)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The main window opens at the position and size of its last close. The plugin saves them
        // in the app data folder, and it does not restore a position that no monitor shows.
        // The window starts hidden (tauri.conf.json). The setup shows it after the plugin
        // restores the state, so the window does not move after it opens.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The app draws its own title bar on Windows. Do not restore the old system frame.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS)
                .build(),
        )
        .manage(Sidecar::default())
        .manage(Tunnels::default())
        .manage(Forwards::default())
        .setup(|app| {
            // The updater (Settings > General > Updates) and the restart after an update. The
            // update address and the release key are in tauri.conf.json (docs/RELEASE.md).
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            if let Some(window) = app.get_window("main") {
                window.show()?;
            }
            // Start the daemon early, so that it is ready when the UI asks for it.
            let sidecar = app.state::<Sidecar>().inner().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = sidecar.ensure() {
                    eprintln!("[harness] {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_info,
            restart_daemon,
            tunnel_open,
            tunnel_close,
            secret_get,
            secret_set,
            secret_delete,
            forward_open,
            forward_close_all,
            browser_open,
            browser_bounds,
            browser_visible,
            browser_navigate,
            browser_history,
            browser_devtools,
            browser_clear_data,
            browser_close,
            browser_close_all
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Tunnels>().close_all();
            handle.state::<Forwards>().close_all();
            handle.state::<Sidecar>().stop();
        }
    });
}
