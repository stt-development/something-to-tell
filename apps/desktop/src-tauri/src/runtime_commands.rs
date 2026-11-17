//! Narrow Tauri adapter: web code cannot choose an executable, origin or arguments.
use crate::runtime_supervisor::{RuntimeConnection, RuntimeSupervisor};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub type DesktopRuntime = Arc<Mutex<RuntimeSupervisor>>;

#[tauri::command]
pub async fn start_bundled_runtime(
    app: AppHandle,
    state: State<'_, DesktopRuntime>,
) -> Result<RuntimeConnection, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "desktop_runtime_unavailable")?;
    let owner = state.inner().clone();
    // Spawn/readiness/health deadlines must not block the WebView event loop.
    tauri::async_runtime::spawn_blocking(move || {
        owner
            .lock()
            .map_err(|_| "desktop_runtime_unavailable".to_string())?
            .start(&resources)
    })
    .await
    .map_err(|_| "desktop_runtime_unavailable".to_string())?
}

#[tauri::command]
pub async fn bundled_runtime_running(state: State<'_, DesktopRuntime>) -> Result<bool, String> {
    let owner = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(owner
            .lock()
            .map_err(|_| "desktop_runtime_unavailable".to_string())?
            .running())
    })
    .await
    .map_err(|_| "desktop_runtime_unavailable".to_string())?
}
