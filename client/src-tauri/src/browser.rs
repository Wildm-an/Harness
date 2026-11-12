//! The Browser pane (SPEC.md section 8.6): child webviews over the pane area of the main window.
//! Each tab of the pane is one webview, with the label "browser-<tab id>".
//!
//! - A page runs in a separate webview. It is not the app origin, so it cannot call Tauri
//!   commands (the capability grants the commands only to the "main" webview).
//! - The browser has its own data folder: a clear of its cookies and storage does not clear the
//!   settings of the app. All tabs share it.
//! - Only http, https, about:, and file: URLs load. A file: page is a local HTML file that the user
//!   opened with "Open HTML file".
//! - Each page load and each title change goes to the app as a "browser-event". A link that
//!   opens a new window goes to the app as a "browser-new-tab": the pane opens it in a new tab.
//! - The annotation script of the app (annotate.ts) sends a note with a navigation to
//!   https://harness-annotate.invalid/#<data>. The webview stops that navigation and gives the data
//!   to the app as a "browser-annotation". The app uses the data only while it annotates the tab.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, Url, WebviewUrl};

const LABEL_PREFIX: &str = "browser-";
/// The host of the address that the annotation script opens to send a note (annotate.ts).
const ANNOTATE_HOST: &str = "harness-annotate.invalid";

// Two open calls for the same tab can come at the same time. Only one makes the webview.
static CREATE: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// true: physical pixels of the window (the app sends these). false: logical pixels.
    #[serde(default)]
    pub physical: bool,
}

impl Bounds {
    fn position(&self) -> Position {
        if self.physical {
            PhysicalPosition::new(self.x.round() as i32, self.y.round() as i32).into()
        } else {
            LogicalPosition::new(self.x, self.y).into()
        }
    }

    fn size(&self) -> Size {
        let (w, h) = (self.width.max(1.0), self.height.max(1.0));
        if self.physical {
            PhysicalSize::new(w.round() as u32, h.round() as u32).into()
        } else {
            LogicalSize::new(w, h).into()
        }
    }
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
struct Annotation {
    id: String,
    data: String, // The encoded text after "#". The app decodes it.
}

#[derive(Clone, Serialize)]
struct NewTab {
    id: String, // The tab that asked for the new window.
    url: String,
}

fn parse_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Not a valid address: {e}"))?;
    if ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        Ok(parsed)
    } else {
        Err(format!("The browser does not open {}: addresses.", parsed.scheme()))
    }
}

/// The schemes that a tab opens and navigates to. "file" is for "Open HTML file" of the Browser pane
/// (`fileUrl` in BrowserPane.tsx): a local page of this computer. The tab webviews have no IPC, so
/// a page cannot call the app. Other schemes (javascript:, data:, a custom protocol) stay blocked.
const ALLOWED_SCHEMES: [&str; 4] = ["http", "https", "about", "file"];

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
///
/// ``fresh``: clear the cookies and storage of all tabs before the page loads. The app sets it for
/// the first tab after a start when "Keep cookies" is "Until quit".
pub fn open(app: &AppHandle, id: &str, url: &str, bounds: Bounds, fresh: bool) -> Result<(), String> {
    let target = parse_url(url)?;
    let _guard = CREATE.lock().map_err(|e| e.to_string())?;
    if let Some(view) = webview(app, id)? {
        set_bounds(app, id, bounds)?;
        view.show().map_err(|e| e.to_string())?;
        return view.navigate(target).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("The main window is missing.")?;
    let (loads, titles, windows, notes) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (load_id, title_id, window_id, note_id) = (id.to_string(), id.to_string(), id.to_string(), id.to_string());
    // A fresh webview starts on a blank page: the clear runs before the page of the tab loads.
    let first = if fresh { Url::parse("about:blank").map_err(|e| e.to_string())? } else { target.clone() };
    let mut builder = WebviewBuilder::new(label(id)?, WebviewUrl::External(first))
        // A new tab does not take the keyboard focus: the user can be typing in the prompt box while
        // the agent opens a page. A click on the page gives it the focus.
        .focused(false)
        .on_navigation(move |url| {
            if url.host_str() == Some(ANNOTATE_HOST) {
                let data = url.fragment().unwrap_or_default().to_string();
                let _ = notes.emit_to("main", "browser-annotation", Annotation { id: note_id.clone(), data });
                return false; // The page stays.
            }
            ALLOWED_SCHEMES.contains(&url.scheme())
        })
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
    let view = window
        .add_child(builder, bounds.position(), bounds.size())
        .map_err(|e| format!("Cannot open the browser: {e}"))?;
    if fresh {
        view.clear_all_browsing_data().map_err(|e| e.to_string())?;
        view.navigate(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Starts a PNG screenshot of the visible part of a tab. The receiver gets the image bytes.
#[cfg(windows)]
pub fn screenshot(app: &AppHandle, id: &str) -> Result<std::sync::mpsc::Receiver<Result<Vec<u8>, String>>, String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::IStream;
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let view = require(app, id)?;
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| {
        let failed = tx.clone();
        // The capture is asynchronous: the handler runs later on the same thread, with the stream full.
        let start = || -> windows::core::Result<()> {
            unsafe {
                let core = platform.controller().CoreWebView2()?;
                let stream: IStream = SHCreateMemStream(None).ok_or_else(windows::core::Error::from_thread)?;
                let filled = stream.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    let bytes = result.and_then(|()| read_stream(&filled)).map_err(|e| e.to_string());
                    let _ = tx.send(bytes);
                    Ok(())
                }));
                core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
            }
        };
        if let Err(e) = start() {
            let _ = failed.send(Err(format!("Cannot take the screenshot: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(rx)
}

/// Starts a DevTools protocol call in the page of a tab (WebView2 CallDevToolsProtocolMethod).
/// The agent uses it to work in the tab of the user. It needs no debug port: only the app can call it.
/// The receiver gets the JSON result of the method.
#[cfg(windows)]
pub fn cdp(app: &AppHandle, id: &str, method: &str, params: &str) -> Result<std::sync::mpsc::Receiver<Result<String, String>>, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    if method.is_empty() || !method.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') {
        return Err(format!("Not a valid method: {method}"));
    }
    let view = require(app, id)?;
    let (tx, rx) = std::sync::mpsc::channel();
    let (method, params) = (HSTRING::from(method), HSTRING::from(params));
    view.with_webview(move |platform| {
        let failed = tx.clone();
        let start = || -> windows::core::Result<()> {
            unsafe {
                let core = platform.controller().CoreWebView2()?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    let _ = tx.send(result.map(|()| json).map_err(|e| e.message().to_string()));
                    Ok(())
                }));
                core.CallDevToolsProtocolMethod(&method, &params, &handler)
            }
        };
        if let Err(e) = start() {
            let _ = failed.send(Err(format!("The browser call failed: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(rx)
}

#[cfg(not(windows))]
pub fn cdp(_app: &AppHandle, _id: &str, _method: &str, _params: &str) -> Result<std::sync::mpsc::Receiver<Result<String, String>>, String> {
    Err("The agent works in the Browser pane only on Windows now.".to_string())
}

#[cfg(windows)]
unsafe fn read_stream(stream: &windows::Win32::System::Com::IStream) -> windows::core::Result<Vec<u8>> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    stream.Seek(0, STREAM_SEEK_SET, None)?;
    let mut bytes = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        stream.Read(buffer.as_mut_ptr().cast(), buffer.len() as u32, Some(&mut read)).ok()?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read as usize]);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
pub fn screenshot(_app: &AppHandle, _id: &str) -> Result<std::sync::mpsc::Receiver<Result<Vec<u8>, String>>, String> {
    Err("Screenshots of the Browser pane work only on Windows now.".to_string())
}

pub fn set_bounds(app: &AppHandle, id: &str, bounds: Bounds) -> Result<(), String> {
    let Some(view) = webview(app, id)? else { return Ok(()) };
    view.set_position(bounds.position()).map_err(|e| e.to_string())?;
    view.set_size(bounds.size()).map_err(|e| e.to_string())
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

/// Runs a script of the app in the page of a tab (the annotation mode).
pub fn eval(app: &AppHandle, id: &str, script: &str) -> Result<(), String> {
    require(app, id)?.eval(script).map_err(|e| e.to_string())
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
    fn only_web_addresses_and_local_files_load() {
        assert!(parse_url("http://localhost:5173/").is_ok());
        assert!(parse_url("https://example.com").is_ok());
        assert!(parse_url("about:blank").is_ok());
        // "Open HTML file" of the Browser pane opens a local page.
        assert!(parse_url("file:///C:/Users/me/site/index.html").is_ok());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(parse_url("tauri://localhost/").is_err());
        assert!(parse_url("ms-settings:privacy").is_err());
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
