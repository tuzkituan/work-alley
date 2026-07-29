// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--scan-once` runs the real scanner headlessly and prints what the dashboard
    // would show. Useful for verifying git output against a terminal without
    // opening a window, and for diagnosing the toolchain on a packaged build.
    if std::env::args().any(|a| a == "--scan-once") {
        work_alley_lib::scan_once_cli();
        return;
    }
    work_alley_lib::run();
}
