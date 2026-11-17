//! Close approval is separate from runtime ownership and never touches project data.
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct CloseRequests {
    sequence: u32,
    pending: Option<u32>,
    approved: bool,
}

impl CloseRequests {
    /// Repeated OS gestures share one pending request; failure stays closed to exit.
    pub fn prevent_exit(&mut self) -> bool {
        if self.approved {
            return false;
        }
        if self.pending.is_none() {
            if let Some(next) = self.sequence.checked_add(1) {
                self.sequence = next;
                self.pending = Some(next);
            }
        }
        true
    }

    fn resolve(&mut self, request_id: u32, approve: bool) -> Result<(), &'static str> {
        if self.pending != Some(request_id) || self.approved {
            return Err("desktop_close_request_stale");
        }
        self.pending = None;
        self.approved = approve;
        Ok(())
    }
}

pub type DesktopCloseRequests = Mutex<CloseRequests>;

#[tauri::command]
pub fn native_close_request(
    state: tauri::State<'_, DesktopCloseRequests>,
) -> Result<Option<u32>, &'static str> {
    Ok(state
        .lock()
        .map_err(|_| "desktop_close_unavailable")?
        .pending)
}

#[tauri::command]
pub fn resolve_native_close(
    app: tauri::AppHandle,
    request_id: u32,
    approve: bool,
) -> Result<(), &'static str> {
    // Drop the mutex before app.exit schedules another ExitRequested callback.
    app.state::<DesktopCloseRequests>()
        .lock()
        .map_err(|_| "desktop_close_unavailable")?
        .resolve(request_id, approve)?;
    if approve {
        app.exit(0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_requests_wait_for_exact_approval() {
        let mut state = CloseRequests::default();
        assert!(state.prevent_exit());
        assert!(state.prevent_exit());
        assert_eq!(state.pending, Some(1));
        assert!(state.resolve(2, true).is_err());
        assert!(state.prevent_exit());
        state.resolve(1, true).unwrap();
        assert!(!state.prevent_exit());
        assert!(state.resolve(1, true).is_err());
    }

    #[test]
    fn cancelled_request_cannot_approve_a_later_exit() {
        let mut state = CloseRequests::default();
        state.prevent_exit();
        state.resolve(1, false).unwrap();
        assert!(state.prevent_exit());
        assert_eq!(state.pending, Some(2));
        assert!(state.resolve(1, true).is_err());
        assert!(!state.approved);
        state.resolve(2, true).unwrap();
        assert!(!state.prevent_exit());
    }

    #[test]
    fn exhaustion_never_reuses_a_request_id() {
        let mut state = CloseRequests {
            sequence: u32::MAX,
            ..Default::default()
        };
        assert!(state.prevent_exit());
        assert_eq!(state.pending, None);
        assert!(state.resolve(u32::MAX, true).is_err());
    }
}
