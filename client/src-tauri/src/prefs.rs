//! A copy of the app settings of the webview (the `harness.*` keys of localStorage) in a file.
//!
//! The webview keeps localStorage in its own database, and it writes changes to disk after a
//! delay. An update ends the app at once (the updater calls `std::process::exit`, and the
//! installer stops a running app), so the newest changes can be lost. The app writes each change
//! to this file too, and copies the file back into localStorage when it starts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub type Prefs = BTreeMap<String, String>;

/// Only the settings of the app go in the file.
pub const PREFIX: &str = "harness.";
/// The file is for small settings. A larger map is an error, not a large file.
const MAX_BYTES: usize = 4 * 1024 * 1024;

pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join("prefs.json")
}

/// The saved settings, or None when there is no file yet (the first start with this version).
/// A damaged file counts as no file: the app then saves its localStorage again.
pub fn load(file: &Path) -> Option<Prefs> {
    let text = std::fs::read_to_string(file).ok()?;
    let prefs: Prefs = serde_json::from_str(&text).ok()?;
    Some(prefs.into_iter().filter(|(k, _)| k.starts_with(PREFIX)).collect())
}

/// Writes the settings to a temporary file, then replaces the file, so that a stop during the
/// write never leaves half a file.
pub fn store(file: &Path, prefs: &Prefs) -> Result<(), String> {
    let kept: Prefs = prefs.iter().filter(|(k, _)| k.starts_with(PREFIX)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let text = serde_json::to_string_pretty(&kept).map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err("The app settings are too large to save.".into());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot make the settings folder: {e}"))?;
    }
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("Cannot save the app settings: {e}"))?;
    std::fs::rename(&temp, file).map_err(|e| format!("Cannot save the app settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("harness-prefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn store_then_load_keeps_only_app_keys() {
        let dir = temp_dir("roundtrip");
        let file = path(&dir);
        assert_eq!(load(&file), None);
        let mut prefs = Prefs::new();
        prefs.insert("harness.appearance".into(), "dark".into());
        prefs.insert("other.key".into(), "x".into());
        store(&file, &prefs).unwrap();
        let loaded = load(&file).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded["harness.appearance"], "dark");
        assert!(!file.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_file_counts_as_no_file() {
        let dir = temp_dir("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path(&dir), "{not json").unwrap();
        assert_eq!(load(&path(&dir)), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
