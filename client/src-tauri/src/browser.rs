//! The Browser pane (SPEC.md section 8.6): child webviews over the pane area of the main window.
//! Each tab of the pane is one webview, with the label "browser-<tab id>".
//!
//! - A page runs in a separate webview. It is not the app origin, so it cannot call Tauri
//!   commands (the capability grants the commands only to the "main" webview).
//! - The browser has its own data folder: a clear of its cookies and storage does not clear the
//!   settings of the app. All tabs share it.
//! - Only http, https, and about: URLs load.
//! - Each page load and each title change goes to the app as a "browser-event". A link that
//!   opens a new window goes to the app as a "browser-new-tab": the pane opens it in a new tab.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

const LABEL_PREFIX: &str = "browser-";

// Two open calls for the same tab can come at the same time. Only one makes the webview.
static CREATE: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Serialize)]
struct BrowserEvent {
    id: String,
    url: String,
    loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Clone, Serialize)]
struct NewTab {
    id: String, // The tab that asked for the new window.
    url: String,
}

fn parse_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Not a valid address: {e}"))?;
    match parsed.scheme() {
        "http" | "https" | "about" => Ok(parsed),
        other => Err(format!("The browser does not open {other}: addresses.")),
    }
}

/// The label of the webview of a tab. A tab id has only letters, digits, and "-".
fn label(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("Not a valid tab id: {id}"));
    }
    Ok(format!("{LABEL_PREFIX}{id}"))
}

fn webview(app: &AppHandle, id: &str) -> Result<Option<tauri::Webview>, String> {
    Ok(app.get_webview(&label(id)?))
}

fn require(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    webview(app, id)?.ok_or_else(|| "The browser tab is not open.".to_string())
}

/// Shows a URL in a tab. Makes the webview of the tab on the first call.
pub fn open(app: &AppHandle, id: &str, url: &str, bounds: Bounds) -> Result<(), String> {
    let target = parse_url(url)?;
    let _guard = CREATE.lock().map_err(|e| e.to_string())?;
    if let Some(view) = webview(app, id)? {
        set_bounds(app, id, bounds)?;
        view.show().map_err(|e| e.to_string())?;
        return view.navigate(target).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("The main window is missing.")?;
    let (loads, titles, windows) = (app.clone(), app.clone(), app.clone());
    let (load_id, title_id, window_id) = (id.to_string(), id.to_string(), id.to_string());
    let mut builder = WebviewBuilder::new(label(id)?, WebviewUrl::External(target))
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .on_page_load(move |_view, payload| {
            let event = BrowserEvent {
                id: load_id.clone(),
                url: payload.url().to_string(),
                loading: matches!(payload.event(), PageLoadEvent::Started),
                title: None,
            };
            let _ = loads.emit_to("main", "browser-event", event);
        })
        .on_document_title_changed(move |view, title| {
            let url = view.url().map(|u| u.to_string()).unwrap_or_default();
            let event = BrowserEvent { id: title_id.clone(), url, loading: false, title: Some(title) };
            let _ = titles.emit_to("main", "browser-event", event);
        })
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = windows.emit_to("main", "browser-new-tab", NewTab { id: window_id.clone(), url: url.to_string() });
            }
            NewWindowResponse::Deny
        });
    if let Ok(dir) = app.path().app_local_data_dir() {
        builder = builder.data_directory(dir.join("browser-profile"));
    }
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| format!("Cannot open the browser: {e}"))?;
    Ok(())
}

pub fn set_bounds(app: &AppHandle, id: &str, bounds: Bounds) -> Result<(), String> {
    let Some(view) = webview(app, id)? else { return Ok(()) };
    view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())
}

pub fn set_visible(app: &AppHandle, id: &str, visible: bool) -> Result<(), String> {
    let Some(view) = webview(app, id)? else { return Ok(()) };
    if visible { view.show() } else { view.hide() }.map_err(|e| e.to_string())
}

pub fn navigate(app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
    let target = parse_url(url)?;
    require(app, id)?.navigate(target).map_err(|e| e.to_string())
}

/// "back", "forward", or "reload".
pub fn history(app: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    let view = require(app, id)?;
    match action {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        _ => return Err(format!("Unknown action: {action}")),
    }
    .map_err(|e| e.to_string())
}

pub fn devtools(app: &AppHandle, id: &str) -> Result<(), String> {
    require(app, id)?.open_devtools();
    Ok(())
}

/// Clears the cookies and storage of all tabs: they share one data folder.
pub fn clear_data(app: &AppHandle, id: &str) -> Result<(), String> {
    require(app, id)?.clear_all_browsing_data().map_err(|e| e.to_string())
}

/// Closes the webview of a tab. A tab with no webview is not an error.
pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    match webview(app, id)? {
        Some(view) => view.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Closes the webviews of all tabs. The app calls it when its page loads: after a reload of the
/// page, the old tabs are gone, but their webviews are still in the window.
pub fn close_all(app: &AppHandle) -> Result<(), String> {
    for (label, view) in app.webviews() {
        if label.starts_with(LABEL_PREFIX) {
            view.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_load() {
        assert!(parse_url("http://localhost:5173/").is_ok());
        assert!(parse_url("https://example.com").is_ok());
        assert!(parse_url("about:blank").is_ok());
        assert!(parse_url("file:///C:/Windows/win.ini").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("not a url").is_err());
    }

    #[test]
    fn tab_ids_make_safe_labels() {
        assert_eq!(label("t1a2").unwrap(), "browser-t1a2");
        assert!(label("").is_err());
        assert!(label("../main").is_err());
        assert!(label("a b").is_err());
    }
}
