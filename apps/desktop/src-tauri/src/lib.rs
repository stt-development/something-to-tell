const DEFAULT_RUNTIME_URL: &str = "http://127.0.0.1:8719";
mod close_requests;
mod export_directory;
mod runtime_commands;
mod runtime_supervisor;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[tauri::command]
fn runtime_url() -> String {
    std::env::var("STT_RUNTIME_URL").unwrap_or_else(|_| DEFAULT_RUNTIME_URL.to_string())
}

#[tauri::command]
/// Opens the operating system folder picker without exposing filesystem access to web code.
fn pick_project_directory(initial_directory: Option<String>) -> Option<String> {
    pick_directory(initial_directory)
}

#[tauri::command]
/// Selects a transient export destination; the web layer does not retain the path.
fn pick_export_directory(initial_directory: Option<String>) -> Option<String> {
    pick_directory(initial_directory)
}

fn pick_directory(initial_directory: Option<String>) -> Option<String> {
    let mut picker = rfd::FileDialog::new();
    if let Some(directory) = initial_directory.filter(|value| !value.trim().is_empty()) {
        picker = picker.set_directory(directory);
    }
    picker
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(close_requests::DesktopCloseRequests::default())
        .manage(Arc::new(Mutex::new(
            runtime_supervisor::RuntimeSupervisor::new(),
        )))
        .invoke_handler(tauri::generate_handler![
            runtime_url,
            runtime_commands::start_bundled_runtime,
            runtime_commands::bundled_runtime_running,
            close_requests::native_close_request,
            close_requests::resolve_native_close,
            pick_project_directory,
            pick_export_directory,
            export_directory::open_export_directory
        ])
        .build(tauri::generate_context!())
        .expect("error while building Something To Tell Engine desktop shell")
        .run(|app, event| {
            match &event {
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    let state = app.state::<close_requests::DesktopCloseRequests>();
                    if state
                        .lock()
                        .map(|mut state| state.prevent_exit())
                        .unwrap_or(true)
                    {
                        api.prevent_close();
                    }
                }
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let state = app.state::<close_requests::DesktopCloseRequests>();
                    if state
                        .lock()
                        .map(|mut state| state.prevent_exit())
                        .unwrap_or(true)
                    {
                        api.prevent_exit();
                    }
                }
                _ => {}
            }
            if let tauri::RunEvent::Exit = event {
                let owner = app.state::<runtime_commands::DesktopRuntime>();
                if let Ok(mut runtime) = owner.lock() {
                    let _ = runtime.stop();
                };
            }
        });
}
