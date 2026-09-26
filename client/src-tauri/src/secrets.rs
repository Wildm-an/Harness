//! Secrets in the operating system keychain (SPEC.md section 9): the tokens of remote daemons.
//! Windows Credential Manager, macOS Keychain, or the Secret Service on Linux.

const SERVICE: &str = "dev.harness.app";

/// Only simple keys, such as "connection:3f2a". The UI cannot read other keychain entries.
fn entry(key: &str) -> Result<keyring::Entry, String> {
    let valid = !key.is_empty()
        && key.len() <= 128
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'));
    if !valid {
        return Err(format!("Not a valid secret key: {key}"));
    }
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("The keychain is not available: {e}"))
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Cannot read from the keychain: {e}")),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| format!("Cannot write to the keychain: {e}"))
}

pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Cannot delete from the keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_keys_that_are_not_simple() {
        assert!(entry("connection:abc-1").is_ok());
        assert!(entry("").is_err());
        assert!(entry("../other app").is_err());
    }
}
