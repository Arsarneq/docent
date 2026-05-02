// Docent Desktop — Tauri v2 application entry point.
// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    docent_desktop_lib::run();
}
