// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    // Sandbox launcher mode: must be handled before any GUI/runtime init.
    if argv.get(1).map(String::as_str) == Some(ccc_lib::sandbox::LAUNCH_FLAG) {
        ccc_lib::sandbox::exec_main(argv);
    }
    ccc_lib::run()
}
