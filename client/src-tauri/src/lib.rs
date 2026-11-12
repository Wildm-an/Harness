mod browser;
mod forward;
mod prefs;
mod secrets;
mod sidecar;
mod tunnel;

use browser::Bounds;
use forward::{ForwardSpec, Forwards};
use sidecar::{DaemonInfo, ServerDaemon, ServerInfo, Sidecar};
use std::sync::Arc;
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

/// The wheel of the daemon of this app version, for "Update daemon" of a remote daemon. The
/// installer has it in the resource folder (`daemon-wheel/`). A development build reads it from
/// `src-tauri/binaries/daemon-wheel/`, which `npm run package` makes.
#[derive(serde::Serialize)]
struct DaemonWheel {
    filename: String,
    data: String, // Base64.
}

#[tauri::command]
async fn daemon_wheel(app: AppHandle) -> Result<DaemonWheel, String> {
    use base64::Engine;
    let mut folders = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        folders.push(dir.join("daemon-wheel"));
    }
    folders.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join("daemon-wheel"));
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("harness_daemon-") && name.ends_with(".whl") {
                let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
                return Ok(DaemonWheel { filename: name, data: base64::engine::general_purpose::STANDARD.encode(bytes) });
            }
        }
    }
    Err("This app has no daemon package. Build the app with npm run package.".to_string())
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

/// Starts the server daemon on `port` for other computers (Settings > Computers), or returns the one
/// that runs. It stops when this app stops. `new_token`: restart it with a new token. It listens only
/// on 127.0.0.1: the other computers connect through an SSH tunnel.
#[tauri::command]
async fn server_daemon_start(
    app: AppHandle,
    state: State<'_, ServerDaemon>,
    port: u16,
    new_token: Option<bool>,
) -> Result<ServerInfo, String> {
    let server = state.inner().clone();
    let resource_dir = app.path().resource_dir().ok();
    let handle = app.clone();
    // A client connects or disconnects, or the daemon stops by itself.
    let on_change: sidecar::OnChange = Arc::new(move || server_daemon_changed(&handle));
    let new_token = new_token.unwrap_or(false);
    let info = tauri::async_runtime::spawn_blocking(move || server.start(resource_dir.as_deref(), port, new_token, on_change))
    .await
    .map_err(|e| e.to_string())??;
    server_daemon_changed(&app);
    Ok(info)
}

/// The running server daemon and its clients, or null.
#[tauri::command]
fn server_daemon_status(state: State<'_, ServerDaemon>) -> Option<ServerInfo> {
    state.status()
}

/// The name of this computer, for the auth message: the Computers page of a server daemon shows it.
#[tauri::command]
fn computer_name() -> Option<String> {
    let var = if cfg!(windows) { "COMPUTERNAME" } else { "HOSTNAME" };
    if let Some(name) = std::env::var(var).ok().filter(|n| !n.trim().is_empty()) {
        return Some(name.trim().to_string());
    }
    let out = std::process::Command::new("hostname").output().ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

#[tauri::command]
async fn server_daemon_stop(app: AppHandle, state: State<'_, ServerDaemon>) -> Result<(), String> {
    let server = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || server.stop()).await.map_err(|e| e.to_string())?;
    server_daemon_changed(&app);
    Ok(())
}

/// The UI event after a start or a stop of the server daemon. The Computers page shows the new state.
const SERVER_DAEMON_EVENT: &str = "server-daemon-changed";

/// The tray menu item "Stop remote daemon". It is in the menu only while the server
/// daemon runs.
#[cfg(desktop)]
struct ServerTrayItem {
    menu: tauri::menu::Menu<tauri::Wry>,
    item: tauri::menu::MenuItem<tauri::Wry>,
    shown: std::sync::Mutex<bool>, // The item is in the menu.
}

/// Shows or removes the tray menu item of the server daemon, and tells the UI. It reads the state
/// itself: a new token stops and starts the daemon, and two threads call this function at once.
fn server_daemon_changed(app: &AppHandle) {
    use tauri::Emitter;
    #[cfg(desktop)]
    if let Some(tray) = app.try_state::<ServerTrayItem>() {
        if let Ok(mut shown) = tray.shown.lock() {
            // In the lock, so that the item goes into the menu only one time.
            let running = app.state::<ServerDaemon>().status().is_some();
            if running && !*shown {
                *shown = tray.menu.insert(&tray.item, 1).is_ok(); // After "Open Harness".
            } else if !running && *shown {
                let _ = tray.menu.remove(&tray.item);
                *shown = false;
            }
        }
    }
    let _ = app.emit(SERVER_DAEMON_EVENT, ());
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
async fn browser_open(app: AppHandle, id: String, url: String, bounds: Bounds, fresh: Option<bool>) -> Result<(), String> {
    browser::open(&app, &id, &url, bounds, fresh.unwrap_or(false))
}

/// Saves a PNG screenshot of the visible part of a tab to ``path`` (from the save dialog).
#[tauri::command]
async fn browser_screenshot(app: AppHandle, id: String, path: String) -> Result<(), String> {
    let rx = browser::screenshot(&app, &id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(15)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "The screenshot did not finish.".to_string())??;
    std::fs::write(&path, bytes).map_err(|e| format!("Cannot save the screenshot: {e}"))
}

/// Saves a file that the app got from the daemon to ``path`` (from the save dialog), for example
/// "Export memory". ``data`` is base64.
#[tauri::command]
async fn save_file(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("The file data is not valid: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Cannot save the file: {e}"))
}

fn prefs_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map(|dir| prefs::path(&dir)).map_err(|e| e.to_string())
}

/// The app settings from the prefs file, or null when there is no file yet (src/lib/prefs.ts).
#[tauri::command]
fn prefs_load(app: AppHandle) -> Result<Option<prefs::Prefs>, String> {
    Ok(prefs::load(&prefs_file(&app)?))
}

/// Saves all the app settings to the prefs file. A sync command: the calls run one at a time.
#[tauri::command]
fn prefs_store(app: AppHandle, prefs: prefs::Prefs) -> Result<(), String> {
    prefs::store(&prefs_file(&app)?, &prefs)
}

/// One folder of the app and its size in bytes, for Settings > General > Storage.
#[derive(serde::Serialize)]
struct AppFolder {
    id: &'static str,
    path: String,
    size: u64,
}

/// The size of the files in a folder and its subfolders. A link is not followed.
fn folder_size(root: &std::path::Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

/// The folders of the desktop app on this computer: the installed app, the data of its webview
/// (the web cache and the app settings), and the profile of the Browser pane.
#[tauri::command]
async fn app_storage(app: AppHandle) -> Result<Vec<AppFolder>, String> {
    let mut folders: Vec<(&'static str, std::path::PathBuf)> = Vec::new();
    // A development build runs from the Cargo target folder, which is not an installed app.
    if !cfg!(debug_assertions) {
        if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|p| p.to_path_buf())) {
            folders.push(("app", dir));
        }
    }
    if let Ok(dir) = app.path().app_local_data_dir() {
        folders.push(("webview", dir.join("EBWebView")));
        folders.push(("browser", dir.join("browser-profile")));
    }
    tauri::async_runtime::spawn_blocking(move || {
        folders
            .into_iter()
            .map(|(id, path)| AppFolder { id, size: folder_size(&path), path: path.to_string_lossy().into_owned() })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The window state flags that the app saves and restores.
fn window_state_flags() -> StateFlags {
    // The app draws its own title bar on Windows. Do not restore the old system frame.
    StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS
}

/// Saves the window position and size before the installer of an update runs. The updater ends
/// the app with `std::process::exit`, so the window state plugin does not save them at the exit.
#[tauri::command]
fn prepare_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_window_state::AppHandleExt;
    app.save_window_state(window_state_flags()).map_err(|e| e.to_string())
}

/// A PNG screenshot of the visible part of a tab, as a data URL: the annotation bar puts it in the prompt.
#[tauri::command]
async fn browser_capture(app: AppHandle, id: String) -> Result<String, String> {
    use base64::Engine;
    let rx = browser::screenshot(&app, &id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(15)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "The screenshot did not finish.".to_string())??;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A DevTools protocol call in the page of a tab, for the agent. ``params`` and the result are JSON text.
#[tauri::command]
async fn browser_cdp(app: AppHandle, id: String, method: String, params: String, timeout: Option<u64>) -> Result<String, String> {
    let rx = browser::cdp(&app, &id, &method, &params)?;
    let wait = std::time::Duration::from_millis(timeout.unwrap_or(30_000).clamp(100, 120_000));
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(wait))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| format!("The page did not answer {method} in time."))?
}

/// The types that Windows runs as a program or a script when it "opens" them. A file card never
/// opens these: the agent made the file, and a click on "Open" must not run it.
const RUN_TYPES: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "msc", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "scr", "pif", "lnk", "url", "reg", "cpl", "hta", "jar", "py", "pyw", "appref-ms", "application", "gadget",
    "inf", "scf", "sct", "chm", "dll", "sys",
];

/// "Open" of a file card in the chat (send_file): the file opens in the default app of the computer.
/// The opener permission of the app page covers only the settings file, so this command checks the
/// path: an absolute path of a file that exists, and not a program or a script.
#[tauri::command]
async fn open_file_in_app(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = std::path::Path::new(&path);
    if !file.is_absolute() || !file.is_file() {
        return Err(format!("The file is not on this computer: {path}"));
    }
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if RUN_TYPES.contains(&ext.as_str()) {
        return Err(format!("Harness does not open .{ext} files: they run as programs. Use \"Show in folder\"."));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
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
async fn browser_eval(app: AppHandle, id: String, script: String) -> Result<(), String> {
    browser::eval(&app, &id, &script)
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

/// The argument of the start at sign-in ("Run on startup"). The app then starts with no window.
const BACKGROUND_ARG: &str = "--background";

/// Shows the main window and gives it the focus (the tray, a second start of the app).
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The tray icon. A left click shows the window. "Quit Harness" shows the window and asks the UI
/// to quit: QuitGuard asks first when the agent works (docs/UI_RULES.md V10a). While the server
/// daemon runs, the menu also has "Stop remote daemon".
#[cfg(desktop)]
fn make_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Emitter;

    let name = app.package_info().name.clone();
    let open = MenuItem::with_id(app, "open", format!("Open {name}"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let server_stop = MenuItem::with_id(app, "server-stop", "Stop remote daemon", true, None::<&str>)?;
    app.manage(ServerTrayItem { menu: menu.clone(), item: server_stop, shown: std::sync::Mutex::new(false) });
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(&name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "server-stop" => {
                // The stop can take some seconds: the daemon stops its turns and servers first.
                let app = app.clone();
                std::thread::spawn(move || {
                    app.state::<ServerDaemon>().stop();
                    server_daemon_changed(&app);
                });
            }
            "quit" => {
                show_main(app);
                let _ = app.emit_to("main", "quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // A second start of the app shows the window of the first one, so two daemons never run.
    // This plugin must be the first one.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
            // "Run on startup" (Settings > General). The Run key of Windows starts the app with
            // --background. The uninstaller removes the value (nsis/installer.nsi).
            .plugin(tauri_plugin_autostart::Builder::new().arg(BACKGROUND_ARG).build())
            .plugin(tauri_plugin_notification::init());
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The main window opens at the position and size of its last close. The plugin saves them
        // in the app data folder, and it does not restore a position that no monitor shows.
        // The window starts hidden (tauri.conf.json). The setup shows it after the plugin
        // restores the state, so the window does not move after it opens.
        .plugin(
            tauri_plugin_window_state::Builder::default().with_state_flags(window_state_flags()).build(),
        )
        .manage(Sidecar::default())
        .manage(ServerDaemon::default())
        .manage(Tunnels::default())
        .manage(Forwards::default())
        .setup(|app| {
            // The updater (Settings > General > Updates) and the restart after an update. The
            // update address and the release key are in tauri.conf.json (docs/RELEASE.md).
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                make_tray(app)?;
                // A click on a Windows notification shows the window, and the UI opens the session of
                // the notification ("notification-open" with its session id). Windows does not do it
                // by itself, and the plugin reports a click only when a handler exists.
                use tauri::Emitter;
                use tauri_plugin_notification::NotificationExt;
                let handle = app.handle().clone();
                let _ = app.notification().on_action(move |performed| {
                    let session = performed
                        .notification()
                        .and_then(|n| n.extra().get("session_id"))
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        show_main(&h);
                        if let Some(id) = session {
                            let _ = h.emit("notification-open", id);
                        }
                    });
                });
            }
            // A start at sign-in keeps the window hidden. The tray icon shows it.
            if !std::env::args().any(|a| a == BACKGROUND_ARG) {
                if let Some(window) = app.get_window("main") {
                    window.show()?;
                }
            }
            // Start the daemon early, so that it is ready when the UI asks for it.
            let sidecar = app.state::<Sidecar>().inner().clone();
            sidecar.set_resource_dir(app.path().resource_dir().ok());
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = sidecar.ensure() {
                    eprintln!("[harness] {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_info,
            daemon_wheel,
            restart_daemon,
            server_daemon_start,
            server_daemon_status,
            server_daemon_stop,
            computer_name,
            tunnel_open,
            tunnel_close,
            secret_get,
            secret_set,
            secret_delete,
            forward_open,
            forward_close_all,
            browser_open,
            browser_bounds,
            open_file_in_app,
            browser_visible,
            browser_navigate,
            browser_history,
            browser_eval,
            browser_devtools,
            browser_clear_data,
            browser_close,
            browser_close_all,
            browser_screenshot,
            browser_capture,
            browser_cdp,
            save_file,
            prefs_load,
            prefs_store,
            prepare_update,
            app_storage
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Tunnels>().close_all();
            handle.state::<Forwards>().close_all();
            handle.state::<Sidecar>().stop();
            handle.state::<ServerDaemon>().stop();
        }
    });
}
