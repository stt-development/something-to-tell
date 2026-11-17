//! One owner for a fixed bundled child. Never discover or terminate by port/name.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const VERSION: u8 = 1;
const MAX_FRAME: u64 = 4096;
const READY_SECONDS: u64 = 15;
const STOP_SECONDS: u64 = 10;
const FAILURE: &str = "desktop_runtime_unavailable";

/// This credential is returned only to trusted in-process UI; never derive Debug.
#[derive(Clone, Serialize)]
pub struct RuntimeConnection {
    pub origin: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    protocol_version: u8,
    r#type: String,
    port: u16,
    pid: u32,
    runtime_version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Health {
    status: String,
    service: String,
    version: String,
}

/// Canonicalize a constant resource path; reject relative paths and escaping aliases.
pub fn runtime_executable(resources: &Path) -> Result<PathBuf, String> {
    if !resources.is_absolute() {
        return Err(FAILURE.into());
    }
    let root = resources.canonicalize().map_err(|_| FAILURE)?;
    let name = if cfg!(windows) {
        "stt-runtime.exe"
    } else {
        "stt-runtime"
    };
    let executable = root
        .join("runtime")
        .join(name)
        .canonicalize()
        .map_err(|_| FAILURE)?;
    if !executable.starts_with(root.join("runtime")) || !executable.is_file() {
        return Err(FAILURE.into());
    }
    Ok(executable)
}

pub struct RuntimeSupervisor {
    child: Option<OwnedRuntime>,
}

impl RuntimeSupervisor {
    pub fn new() -> Self {
        Self { child: None }
    }

    /// Explicit start/retry is idempotent while our child lives; status never restarts it.
    pub fn start(&mut self, resources: &Path) -> Result<RuntimeConnection, String> {
        if let Some(child) = self.child.as_mut() {
            if child.alive()? {
                return Ok(child.connection.clone());
            }
        }
        self.child.take();
        let child = OwnedRuntime::spawn(
            &runtime_executable(resources)?,
            Duration::from_secs(READY_SECONDS),
        )?;
        let connection = child.connection.clone();
        self.child = Some(child);
        Ok(connection)
    }

    pub fn running(&mut self) -> bool {
        self.child
            .as_mut()
            .is_some_and(|child| child.alive().unwrap_or(false))
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            child.stop(Duration::from_secs(STOP_SECONDS))?;
        }
        Ok(())
    }
}

struct OwnedRuntime {
    child: Child,
    input: Option<ChildStdin>,
    events: Receiver<Result<Vec<u8>, ()>>,
    connection: RuntimeConnection,
}

impl OwnedRuntime {
    fn spawn(executable: &Path, timeout: Duration) -> Result<Self, String> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| FAILURE)?;
        let token = URL_SAFE_NO_PAD.encode(random);
        let mut command = Command::new(executable);
        command
            .arg("--desktop")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW; no console for the sidecar.
        }
        let mut child = command.spawn().map_err(|_| FAILURE)?;
        let input = child.stdin.take();
        let stdout = child.stdout.take().ok_or(FAILURE)?;
        let (sender, events) = sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let result = reader
                    .by_ref()
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut bytes);
                if result.is_err()
                    || bytes.is_empty()
                    || bytes.len() as u64 > MAX_FRAME
                    || bytes.last() != Some(&b'\n')
                {
                    let _ = sender.send(Err(()));
                    break;
                }
                if sender.send(Ok(bytes)).is_err() {
                    break;
                }
            }
        });
        let mut owned = Self {
            child,
            input,
            events,
            connection: RuntimeConnection {
                origin: String::new(),
                token,
            },
        };
        let deadline = Instant::now() + timeout;
        let bootstrap = serde_json::json!({"protocol_version": VERSION, "type": "bootstrap", "token": owned.connection.token});
        let input = owned.input.as_mut().ok_or(FAILURE)?;
        writeln!(input, "{bootstrap}").map_err(|_| FAILURE)?;
        input.flush().map_err(|_| FAILURE)?;
        let bytes = owned
            .events
            .recv_timeout(timeout)
            .map_err(|_| FAILURE)?
            .map_err(|_| FAILURE)?;
        let ready: Ready = serde_json::from_slice(&bytes).map_err(|_| FAILURE)?;
        if ready.protocol_version != VERSION
            || ready.r#type != "ready"
            || ready.port == 0
            || ready.pid != owned.child.id()
            || ready.runtime_version != env!("CARGO_PKG_VERSION")
            || !owned.alive()?
        {
            return Err(FAILURE.into());
        }
        owned.connection.origin = format!("http://127.0.0.1:{}", ready.port);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(FAILURE.into());
        }
        owned.check_health(remaining.min(Duration::from_secs(2)))?;
        if !owned.alive()? {
            return Err(FAILURE.into());
        }
        Ok(owned)
    }

    fn check_health(&self, timeout: Duration) -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|_| FAILURE)?;
        let response = client
            .get(format!("{}/api/health", self.connection.origin))
            .bearer_auth(&self.connection.token)
            .send()
            .map_err(|_| FAILURE)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(FAILURE.into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_FRAME + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| FAILURE)?;
        if bytes.len() as u64 > MAX_FRAME {
            return Err(FAILURE.into());
        }
        let health: Health = serde_json::from_slice(&bytes).map_err(|_| FAILURE)?;
        if health.status != "ok"
            || health.service != "runtime"
            || health.version != env!("CARGO_PKG_VERSION")
        {
            return Err(FAILURE.into());
        }
        Ok(())
    }

    fn alive(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|_| FAILURE.into())
    }

    fn stop(&mut self, timeout: Duration) -> Result<(), String> {
        if let Some(mut input) = self.input.take() {
            let _ = writeln!(input, "{{\"protocol_version\":1,\"type\":\"shutdown\"}}");
            let _ = input.flush();
        } // EOF is a second graceful-stop signal, never a domain Save/Discard command.
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().map_err(|_| FAILURE)? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(FAILURE.into())
                };
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err(FAILURE.into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        let _ = self.stop(Duration::from_secs(STOP_SECONDS));
    }
}

#[cfg(test)]
mod tests;
