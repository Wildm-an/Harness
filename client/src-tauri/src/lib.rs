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

#[tauri::command]
fn browser_open(app: AppHandle, url: String, bounds: Bounds) -> Result<(), String> {
    browser::open(&app, &url, bounds)
}

#[tauri::command]
fn browser_bounds(app: AppHandle, bounds: Bounds) -> Result<(), String> {
    browser::set_bounds(&app, bounds)
}

#[tauri::command]
fn browser_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    browser::set_visible(&app, visible)
}

#[tauri::command]
fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    browser::navigate(&app, &url)
}

#[tauri::command]
fn browser_history(app: AppHandle, action: String) -> Result<(), String> {
    browser::history(&app, &action)
}

#[tauri::command]
fn browser_devtools(app: AppHandle) -> Result<(), String> {
    browser::devtools(&app)
}

#[tauri::command]
fn browser_clear_data(app: AppHandle) -> Result<(), String> {
    browser::clear_data(&app)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar::default())
        .manage(Tunnels::default())
        .manage(Forwards::default())
        .setup(|app| {
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
            browser_clear_data
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
