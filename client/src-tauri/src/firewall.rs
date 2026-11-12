//! The Windows Firewall rule of the server daemon (Settings > Computers, "Also listen on Tailscale").
//!
//! Windows Firewall drops the connections of other computers to a new program. It asks the user one
//! time, and a closed dialog makes a block rule for the program. So the play button checks the
//! firewall, and only when something is missing it asks for administrator rights (the UAC prompt)
//! to change it:
//!
//! - An allow rule "Harness remote daemon": TCP, the daemon port, only from Tailscale addresses
//!   (100.64.0.0/10), only for the daemon program, and only on the Tailscale interface.
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

/// The characters that PowerShell reads as a single quote: the ASCII quote and U+2018 to U+201B.
#[cfg(windows)]
const SINGLE_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// A text for a single-quoted PowerShell string. Each quote character is doubled, as PowerShell
/// requires, so the text cannot end the string.
#[cfg(windows)]
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for c in text.chars() {
        if SINGLE_QUOTES.contains(&c) {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// The rules named "Harness remote daemon" that allow the port and, when the program is known, apply
/// to that program. A rule of another program path (for example after a new install folder) does not
/// count.
#[cfg(windows)]
fn allow_rules_script(port: u16, program: Option<&Path>) -> String {
    let program_filter = match program {
        Some(program) => format!(
            " | Where-Object {{ ($_ | Get-NetFirewallApplicationFilter).Program -eq {} }}",
            quote(&program.to_string_lossy())
        ),
        None => String::new(),
    };
    format!(
        "$rule = @(Get-NetFirewallRule -DisplayName {name} -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' }} | \
         Where-Object {{ ($_ | Get-NetFirewallPortFilter).LocalPort -contains '{port}' }}{program_filter})\n",
        name = quote(RULE_NAME),
    )
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
         {rules}\
         {blocks}\
         if ($rule.Count -gt 0 -and $blocks.Count -eq 0) {{ 'open' }} else {{ 'blocked' }}\n",
        rules = allow_rules_script(port, program),
        blocks = blocks_script(program),
    )
}

/// The change, run with administrator rights: remove the block rules, then add the allow rule.
/// The rule applies only to the daemon program (when it is known), and only to the interface that has
/// the Tailscale address (when Windows finds it). Splatting (`@limits`) adds these parameters.
#[cfg(windows)]
fn open_script(port: u16, program: Option<&Path>, tailscale_ip: Option<&str>) -> String {
    let program_limit = match program {
        Some(program) => format!("$limits['Program'] = {}\n", quote(&program.to_string_lossy())),
        None => String::new(),
    };
    let interface_limit = match tailscale_ip {
        Some(ip) => format!(
            "$alias = @(Get-NetIPAddress -IPAddress {} -ErrorAction SilentlyContinue)[0].InterfaceAlias\n\
             if ($alias) {{ $limits['InterfaceAlias'] = $alias }}\n",
            quote(ip)
        ),
        None => String::new(),
    };
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         {blocks}\
         $blocks | Remove-NetFirewallRule\n\
         Get-NetFirewallRule -DisplayName {name} -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
         $limits = @{{}}\n\
         {program_limit}\
         {interface_limit}\
         New-NetFirewallRule -DisplayName {name} -Description 'Lets other computers of your Tailscale network connect to the Harness daemon.' \
         -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -RemoteAddress {range} -Profile Any @limits | Out-Null\n",
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

/// Opens the port for Tailscale. Windows shows its administrator prompt (UAC). `tailscale_ip`: the
/// Tailscale address of this computer, to limit the rule to its interface.
#[cfg(windows)]
pub fn open(port: u16, program: Option<&Path>, tailscale_ip: Option<&str>) -> Result<(), String> {
    // The outer PowerShell has no rights. Start-Process -Verb RunAs shows the prompt, and starts the
    // inner PowerShell with administrator rights. A closed prompt is an error of Start-Process.
    let inner = encoded(&open_script(port, program, tailscale_ip));
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
pub fn open(_port: u16, _program: Option<&std::path::Path>, _tailscale_ip: Option<&str>) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn quote_doubles_every_single_quote_character() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("it's"), "'it''s'");
        assert_eq!(quote("a\u{2018}b\u{2019}c\u{201A}d\u{201B}e"), "'a\u{2018}\u{2018}b\u{2019}\u{2019}c\u{201A}\u{201A}d\u{201B}\u{201B}e'");
    }

    #[test]
    fn scripts_quote_the_program_and_limit_the_rule() {
        let program = Path::new(r"C:\Users\it's me\Harness\harness-daemon\harness-daemon.exe");
        let quoted = r"'C:\Users\it''s me\Harness\harness-daemon\harness-daemon.exe'";
        let open = open_script(8765, Some(program), Some("100.72.1.2"));
        assert!(open.contains(&format!("-Program {quoted}")));
        assert!(open.contains(&format!("$limits['Program'] = {quoted}")));
        assert!(open.contains("Get-NetIPAddress -IPAddress '100.72.1.2'"));
        assert!(open.contains("-LocalPort 8765 -RemoteAddress 100.64.0.0/10 -Profile Any @limits"));
        assert!(open.contains("-Action Allow"));
        let check = check_script(8765, Some(program));
        assert!(check.contains(&format!("Get-NetFirewallApplicationFilter).Program -eq {quoted}")));
        // The development daemon: no program limit, and no interface limit without an address.
        let dev = open_script(8765, None, None);
        assert!(!dev.contains("$limits['Program']") && !dev.contains("Get-NetIPAddress"));
        assert!(check_script(8765, None).contains("$blocks = @()"));
    }

    #[test]
    fn the_encoded_script_is_utf16_base64() {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded("'ok'")).unwrap();
        assert_eq!(bytes, vec![b'\'', 0, b'o', 0, b'k', 0, b'\'', 0]);
    }

    /// PowerShell parses the scripts with no errors. Parse only: nothing runs, and nothing changes.
    #[test]
    fn powershell_parses_the_scripts() {
        let program = Path::new(r"C:\Program Files\it's ‘Harness’\harness-daemon.exe");
        for script in [open_script(8765, Some(program), Some("100.72.1.2")), check_script(8765, Some(program))] {
            let parse = format!(
                "$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')); $e = $null; \
                 [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$e); $e.Count",
                encoded(&script)
            );
            let out = powershell(&["-Command", &parse]).unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0", "parse errors in:\n{script}");
        }
    }

    /// The read-only check runs on this computer. It changes nothing.
    #[test]
    fn the_check_reads_the_rules() {
        assert!(check(8765, None).is_ok());
    }
}
