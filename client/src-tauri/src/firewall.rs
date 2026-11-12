//! The Windows Firewall rule of the server daemon (Settings > Computers, "Also listen on Tailscale").
//!
//! Windows Firewall drops the connections of other computers to a new program. It asks the user one
//! time, and a closed dialog makes a block rule for the program. So the play button checks the
//! firewall, and only when something is missing it asks for administrator rights (the UAC prompt)
//! to change it:
//!
//! - An allow rule "Harness remote daemon": TCP, the daemon port, only from Tailscale addresses
//!   (100.64.0.0/10).
//! - No enabled block rule for the daemon program. A block rule wins over an allow rule.
//!
//! The check needs no administrator rights. On macOS and Linux this module does nothing.

#[cfg(windows)]
use std::path::Path;

pub const RULE_NAME: &str = "Harness remote daemon";
#[cfg(windows)]
const TAILSCALE_RANGE: &str = "100.64.0.0/10";

/// The state of the firewall for the server daemon.
#[derive(Clone, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FirewallState {
    /// Other computers of the tailnet can connect. Also on macOS and Linux.
    Open,
    /// The allow rule is missing, or a block rule stops the daemon program.
    Blocked,
}

/// A text for a single-quoted PowerShell string.
#[cfg(windows)]
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The PowerShell lines that find the enabled block rules of the daemon program, in `$blocks`.
#[cfg(windows)]
fn blocks_script(program: Option<&Path>) -> String {
    match program {
        Some(program) => format!(
            "$blocks = @(Get-NetFirewallApplicationFilter -Program {} -ErrorAction SilentlyContinue | \
             Get-NetFirewallRule | Where-Object {{ $_.Enabled -eq 'True' -and $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' }})\n",
            quote(&program.to_string_lossy())
        ),
        None => "$blocks = @()\n".to_string(),
    }
}

/// The read-only check: prints "open" or "blocked".
#[cfg(windows)]
fn check_script(port: u16, program: Option<&Path>) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $rule = @(Get-NetFirewallRule -DisplayName {name} -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' }} | \
         Where-Object {{ ($_ | Get-NetFirewallPortFilter).LocalPort -contains '{port}' }})\n\
         {blocks}\
         if ($rule.Count -gt 0 -and $blocks.Count -eq 0) {{ 'open' }} else {{ 'blocked' }}\n",
        name = quote(RULE_NAME),
        blocks = blocks_script(program),
    )
}

/// The change, run with administrator rights: remove the block rules, then add the allow rule.
#[cfg(windows)]
fn open_script(port: u16, program: Option<&Path>) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         {blocks}\
         $blocks | Remove-NetFirewallRule\n\
         Get-NetFirewallRule -DisplayName {name} -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
         New-NetFirewallRule -DisplayName {name} -Description 'Lets other computers of your Tailscale network connect to the Harness daemon.' \
         -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -RemoteAddress {range} -Profile Any | Out-Null\n",
        name = quote(RULE_NAME),
        blocks = blocks_script(program),
        range = TAILSCALE_RANGE,
    )
}

/// `powershell -EncodedCommand`: the script as base64 of UTF-16LE. No quoting problems.
#[cfg(windows)]
fn encoded(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(windows)]
fn powershell(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Cannot start PowerShell: {e}"))
}

/// Checks the firewall. Needs no administrator rights.
#[cfg(windows)]
pub fn check(port: u16, program: Option<&Path>) -> Result<FirewallState, String> {
    let out = powershell(&["-EncodedCommand", &encoded(&check_script(port, program))])?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.trim() {
        "open" => Ok(FirewallState::Open),
        "blocked" => Ok(FirewallState::Blocked),
        _ => Err(format!(
            "Cannot read the Windows Firewall rules: {}",
            String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("no output")
        )),
    }
}

/// Opens the port for Tailscale. Windows shows its administrator prompt (UAC).
#[cfg(windows)]
pub fn open(port: u16, program: Option<&Path>) -> Result<(), String> {
    // The outer PowerShell has no rights. Start-Process -Verb RunAs shows the prompt, and starts the
    // inner PowerShell with administrator rights. A closed prompt is an error of Start-Process.
    let inner = encoded(&open_script(port, program));
    let outer = format!(
        "try {{ $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{inner}'; exit $p.ExitCode }} \
         catch {{ exit 1223 }}"
    );
    let out = powershell(&["-Command", &outer])?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(1223) => Err("Windows did not change the firewall: the administrator prompt was closed.".into()),
        code => Err(format!("Windows could not change the firewall (exit code {}).", code.unwrap_or(-1))),
    }
}

#[cfg(not(windows))]
pub fn check(_port: u16, _program: Option<&std::path::Path>) -> Result<FirewallState, String> {
    Ok(FirewallState::Open)
}

#[cfg(not(windows))]
pub fn open(_port: u16, _program: Option<&std::path::Path>) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn scripts_quote_the_program_and_limit_the_rule_to_tailscale() {
        let program = Path::new(r"C:\Users\it's me\Harness\harness-daemon\harness-daemon.exe");
        let open = open_script(8765, Some(program));
        assert!(open.contains(r"-Program 'C:\Users\it''s me\Harness\harness-daemon\harness-daemon.exe'"));
        assert!(open.contains("-LocalPort 8765 -RemoteAddress 100.64.0.0/10"));
        assert!(open.contains("-Action Allow"));
        assert!(check_script(8765, None).contains("$blocks = @()"));
    }

    #[test]
    fn the_encoded_script_is_utf16_base64() {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded("'ok'")).unwrap();
        assert_eq!(bytes, vec![b'\'', 0, b'o', 0, b'k', 0, b'\'', 0]);
    }

    /// The read-only check runs on this computer. It changes nothing.
    #[test]
    fn the_check_reads_the_rules() {
        assert!(check(8765, None).is_ok());
    }
}
