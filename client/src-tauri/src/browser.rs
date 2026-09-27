//! The Browser pane (SPEC.md section 8.6): a child webview over the pane area of the main window.
//!
//! - The page runs in a separate webview. It is not the app origin, so it cannot call Tauri
//!   commands (the capability grants the commands only to the "main" webview).
//! - The browser has its own data folder: a clear of its cookies and storage does not clear the
//!   settings of the app.
//! - Only http, https, and about: URLs load.
//! - Each page load goes to the app as a "browser-event".

use serde::{Deserialize, Serialize};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

pub const LABEL: &str = "browser";

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Serialize)]
struct BrowserEvent {
    url: String,
    loading: bool,
}

fn parse_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Not a valid address: {e}"))?;
    match parsed.scheme() {
        "http" | "https" | "about" => Ok(parsed),
        other => Err(format!("The browser does not open {other}: addresses.")),
    }
}

fn webview(app: &AppHandle) -> Option<tauri::Webview> {
    app.get_webview(LABEL)
}

/// Shows a URL. Makes the webview on the first call.
pub fn open(app: &AppHandle, url: &str, bounds: Bounds) -> Result<(), String> {
    let target = parse_url(url)?;
    if let Some(view) = webview(app) {
        set_bounds(app, bounds)?;
        view.show().map_err(|e| e.to_string())?;
        return view.navigate(target).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("The main window is missing.")?;
    let events = app.clone();
    let loads = app.clone();
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(target))
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .on_page_load(move |_view, payload| {
            let event = BrowserEvent {
                url: payload.url().to_string(),
                loading: matches!(payload.event(), PageLoadEvent::Started),
            };
            let _ = loads.emit_to("main", "browser-event", event);
        });
    if let Ok(dir) = events.path().app_local_data_dir() {
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

pub fn set_bounds(app: &AppHandle, bounds: Bounds) -> Result<(), String> {
    let Some(view) = webview(app) else { return Ok(()) };
    view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())
}

pub fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let Some(view) = webview(app) else { return Ok(()) };
    if visible { view.show() } else { view.hide() }.map_err(|e| e.to_string())
}

pub fn navigate(app: &AppHandle, url: &str) -> Result<(), String> {
    let target = parse_url(url)?;
    webview(app).ok_or("The browser is not open.")?.navigate(target).map_err(|e| e.to_string())
}

/// "back", "forward", or "reload".
pub fn history(app: &AppHandle, action: &str) -> Result<(), String> {
    let view = webview(app).ok_or("The browser is not open.")?;
    match action {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        _ => return Err(format!("Unknown action: {action}")),
    }
    .map_err(|e| e.to_string())
}

pub fn devtools(app: &AppHandle) -> Result<(), String> {
    webview(app).ok_or("The browser is not open.")?.open_devtools();
    Ok(())
}

pub fn clear_data(app: &AppHandle) -> Result<(), String> {
    webview(app).ok_or("The browser is not open.")?.clear_all_browsing_data().map_err(|e| e.to_string())
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
}
