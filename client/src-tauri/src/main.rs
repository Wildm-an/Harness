// Do not open a console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh runs this program as SSH_ASKPASS for a password login (tunnel.rs): print and stop.
    if harness_lib::askpass() {
        return;
    }
    harness_lib::run()
}
