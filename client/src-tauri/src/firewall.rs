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
/// the Tailscale address (when Windows finds it). Splatting (`@l`) adds these parameters.
///
/// The script is compact on purpose: `-Verb RunAs` starts the process through ShellExecute, which can
/// cut a long argument list (about 2,048 characters), and `-EncodedCommand` makes the text 2.7 times
/// longer. A cut script does not run, and PowerShell exits with code 1. ELEVATED_MAX keeps it short.
/// Each step sets $s. An error stops the script with the exit code of its step (STEP_ERRORS).
#[cfg(windows)]
fn open_script(port: u16, program: Option<&Path>, tailscale_ip: Option<&str>) -> String {
    let mut script = format!("$ErrorActionPreference='Stop';$s={STEP_READ};try{{\n");
    match program {
        Some(program) => script.push_str(&format!(
            "$p={}\n\
             $b=@(Get-NetFirewallApplicationFilter -Program $p -EA 0|Get-NetFirewallRule|?{{$_.Action -eq 'Block' -and $_.Direction -eq 'Inbound'}})\n\
             $s={STEP_REMOVE_BLOCKS};$b|Remove-NetFirewallRule\n\
             $l=@{{Program=$p}}\n",
            quote(&program.to_string_lossy())
        )),
        None => script.push_str("$l=@{}\n"),
    }
    script.push_str(&format!(
        "$s={STEP_REMOVE_OLD};Get-NetFirewallRule -DisplayName {name} -EA 0|Remove-NetFirewallRule\n",
        name = quote(RULE_NAME)
    ));
    if let Some(ip) = tailscale_ip {
        script.push_str(&format!(
            "$s={STEP_INTERFACE};$a=@(Get-NetIPAddress -IPAddress {} -EA 0)[0].InterfaceAlias;if($a){{$l.InterfaceAlias=$a}}\n",
            quote(ip)
        ));
    }
    // The defaults of New-NetFirewallRule are -Direction Inbound and -Profile Any.
    script.push_str(&format!(
        "$s={STEP_ADD};New-NetFirewallRule -DisplayName {name} -Action Allow -Protocol TCP \
         -LocalPort {port} -RemoteAddress {TAILSCALE_RANGE} @l >$null\n\
         }}catch{{exit $s}}\nexit 0\n",
        name = quote(RULE_NAME)
    ));
    script
}

/// The longest base64 text of the elevated script, below the limit of ShellExecute (about 2,048).
#[cfg(windows)]
const ELEVATED_MAX: usize = 1900;

// The exit codes of the steps of the elevated script.
#[cfg(windows)]
const STEP_READ: i32 = 10;
#[cfg(windows)]
const STEP_REMOVE_BLOCKS: i32 = 11;
#[cfg(windows)]
const STEP_REMOVE_OLD: i32 = 12;
#[cfg(windows)]
const STEP_INTERFACE: i32 = 13;
#[cfg(windows)]
const STEP_ADD: i32 = 14;

/// The error text for an exit code of the elevated script.
#[cfg(windows)]
fn step_error(code: Option<i32>) -> String {
    let what = match code {
        Some(STEP_READ) => "it could not read the block rules of the daemon program".to_string(),
        Some(STEP_REMOVE_BLOCKS) => {
            "it could not remove the block rules of the daemon program. A policy of the computer (for example \
             Group Policy or a security program) can own them"
                .to_string()
        }
        Some(STEP_REMOVE_OLD) => format!("it could not remove the old rule \"{RULE_NAME}\""),
        Some(STEP_INTERFACE) => "it could not find the network interface of the Tailscale address".to_string(),
        Some(STEP_ADD) => format!("it could not add the rule \"{RULE_NAME}\". A policy of the computer can forbid new rules"),
        // 1: PowerShell did not run the script, or an error happened outside the steps. An antivirus
        // program can block a hidden PowerShell script with administrator rights.
        Some(1) => "PowerShell did not run the script (exit code 1). An antivirus program or a policy of the computer \
                    can block it"
            .to_string(),
        Some(code) => format!("PowerShell stopped with exit code {code}"),
        None => "PowerShell stopped".to_string(),
    };
    format!("Windows could not change the firewall: {what}.")
}

/// The outer PowerShell command: it starts the inner script and exits with its exit code. With
/// `elevate`, Windows shows its administrator prompt (Start-Process -Verb RunAs). A closed prompt is an
/// error of Start-Process: exit code 1223.
#[cfg(windows)]
fn outer_command(inner: &str, elevate: bool) -> String {
    let verb = if elevate { "-Verb RunAs " } else { "" };
    format!(
        "try {{ $p = Start-Process powershell.exe {verb}-Wait -PassThru -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{inner}'; exit $p.ExitCode }} \
         catch {{ exit 1223 }}"
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
    let mut inner = encoded(&open_script(port, program, tailscale_ip));
    if inner.len() > ELEVATED_MAX {
        // A very long program path: leave out the interface limit, then the program limit.
        inner = encoded(&open_script(port, program, None));
    }
    if inner.len() > ELEVATED_MAX {
        inner = encoded(&open_script(port, None, None));
    }
    let out = powershell(&["-Command", &outer_command(&inner, true)])?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(1223) => Err("Windows did not change the firewall: the administrator prompt was closed.".into()),
        code => Err(step_error(code)),
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
        assert!(open.contains(&format!("$p={quoted}")));
        assert!(open.contains("-Program $p") && open.contains("$l=@{Program=$p}"));
        assert!(open.contains("Get-NetIPAddress -IPAddress '100.72.1.2'"));
        assert!(open.contains("-LocalPort 8765 -RemoteAddress 100.64.0.0/10 @l >$null"));
        assert!(open.contains("-Action Allow"));
        let check = check_script(8765, Some(program));
        assert!(check.contains(&format!("Get-NetFirewallApplicationFilter).Program -eq {quoted}")));
        // The development daemon: no program limit, and no interface limit without an address.
        let dev = open_script(8765, None, None);
        assert!(!dev.contains("Program") && !dev.contains("Get-NetIPAddress"));
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

    /// The elevated command stays below the limit of ShellExecute, also with a long install path. A
    /// Windows user name has 20 characters or less: the test uses 40.
    #[test]
    fn the_elevated_script_is_short() {
        let long = format!(r"C:\Users\{}\AppData\Local\Harness\harness-daemon\harness-daemon.exe", "a".repeat(40));
        let inner = encoded(&open_script(8765, Some(Path::new(&long)), Some("100.127.129.77")));
        assert!(inner.len() <= ELEVATED_MAX, "the encoded script has {} characters", inner.len());
    }

    /// The outer command gives the exit code of the inner script. No elevation, and a harmless script.
    #[test]
    fn the_outer_command_returns_the_exit_code_of_the_script() {
        let out = powershell(&["-Command", &outer_command(&encoded("exit 7"), false)]).unwrap();
        assert_eq!(out.status.code(), Some(7));
    }

    /// A failed step gives its exit code. The script here has only a failing step: it changes nothing.
    #[test]
    fn a_failed_step_gives_its_exit_code() {
        let script = "$ErrorActionPreference = 'Stop'\n$step = 13\ntry {\nGet-Item -LiteralPath 'Z:\\no\\such\\file'\n} catch { exit $step }\nexit 0\n";
        let out = powershell(&["-Command", &outer_command(&encoded(script), false)]).unwrap();
        assert_eq!(out.status.code(), Some(STEP_INTERFACE));
        assert!(step_error(Some(STEP_REMOVE_BLOCKS)).contains("block rules"));
        assert!(step_error(Some(1)).contains("exit code 1"));
        assert!(step_error(Some(9)).contains("exit code 9"));
    }

    /// The read-only check runs on this computer. It changes nothing.
    #[test]
    fn the_check_reads_the_rules() {
        assert!(check(8765, None).is_ok());
    }
}
