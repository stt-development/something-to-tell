//! Real fixture children prove ownership and failure cleanup without a native window.
use super::*;
use std::fs;
use std::sync::OnceLock;

struct Resources(PathBuf);

fn fixture_binary() -> &'static PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY.get_or_init(|| {
        let root = temporary_root();
        fs::create_dir_all(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime_child.rs");
        assert!(Command::new("rustc")
            .arg(source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success());
        executable
    })
}

fn temporary_root() -> PathBuf {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).unwrap();
    std::env::temp_dir().join(format!("stt-supervisor-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

impl Resources {
    fn new(mode: &str) -> Self {
        let root = temporary_root().join(mode);
        fs::create_dir_all(root.join("runtime")).unwrap();
        let name = if cfg!(windows) {
            "stt-runtime.exe"
        } else {
            "stt-runtime"
        };
        fs::copy(fixture_binary(), root.join("runtime").join(name)).unwrap();
        Self(root)
    }
    fn assert_listener_released(&self) {
        if let Ok(value) = fs::read_to_string(self.0.join("port.txt")) {
            let port: u16 = value.parse().unwrap();
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            assert!(
                std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err()
            );
        }
    }
}

impl Drop for Resources {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0.parent().unwrap());
    }
}

#[test]
fn shared_golden_ready_frame_and_limits_match() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/contracts/fixtures/desktop-runtime-v1.json"
    ))
    .unwrap();
    assert_eq!(golden["constants"]["version"], VERSION);
    assert_eq!(golden["constants"]["max_frame_bytes"], MAX_FRAME);
    assert_eq!(golden["constants"]["ready_timeout_seconds"], READY_SECONDS);
    assert_eq!(
        golden["constants"]["shutdown_timeout_seconds"],
        STOP_SECONDS
    );
    let ready: Ready = serde_json::from_value(golden["ready"].clone()).unwrap();
    assert_eq!(ready.r#type, "ready");
    assert!(serde_json::from_str::<Ready>("{\"protocol_version\":true}").is_err());
}

#[test]
fn relative_missing_and_escaping_resource_paths_fail_closed() {
    assert!(runtime_executable(Path::new("relative")).is_err());
    let missing = temporary_root();
    assert!(runtime_executable(&missing).is_err());
    #[cfg(unix)]
    {
        let resource = Resources::new("normal");
        let binary = resource.0.join("runtime/stt-runtime");
        fs::remove_file(&binary).unwrap();
        std::os::unix::fs::symlink(fixture_binary(), binary).unwrap();
        assert!(runtime_executable(&resource.0).is_err());
    }
}

#[test]
fn explicit_start_is_idempotent_and_stop_reaps_only_owned_child() {
    let resource = Resources::new("normal");
    let mut supervisor = RuntimeSupervisor::new();
    let first = supervisor.start(&resource.0).unwrap();
    let second = supervisor.start(&resource.0).unwrap();
    assert_eq!(first.origin, second.origin);
    assert_eq!(first.token, second.token);
    assert_eq!(URL_SAFE_NO_PAD.decode(&first.token).unwrap().len(), 32);
    assert!(supervisor.running());
    supervisor.stop().unwrap();
    assert!(!supervisor.running());
    resource.assert_listener_released();
    let restarted = supervisor.start(&resource.0).unwrap();
    assert_ne!(first.token, restarted.token);
    supervisor.child.as_mut().unwrap().child.kill().unwrap();
    for _ in 0..50 {
        if !supervisor.running() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!supervisor.running()); // Status must not transparently replace authority.
}

#[test]
fn rejected_frames_identity_health_and_redirect_leave_no_listener() {
    for mode in [
        "invalid",
        "oversized",
        "wrong_pid",
        "wrong_version",
        "bad_health",
        "bad_json",
        "redirect",
    ] {
        let resource = Resources::new(mode);
        let mut supervisor = RuntimeSupervisor::new();
        assert_eq!(
            supervisor.start(&resource.0).err().as_deref(),
            Some(FAILURE),
            "{mode}"
        );
        assert!(!supervisor.running());
        resource.assert_listener_released();
    }
}

#[test]
fn readiness_timeout_and_drop_release_owned_fixture() {
    let resource = Resources::new("timeout");
    let executable = runtime_executable(&resource.0).unwrap();
    assert!(OwnedRuntime::spawn(&executable, Duration::from_millis(500)).is_err());
    resource.assert_listener_released();
    let resource = Resources::new("normal");
    {
        let mut supervisor = RuntimeSupervisor::new();
        supervisor.start(&resource.0).unwrap();
    }
    resource.assert_listener_released();
}

#[test]
#[ignore = "requires freshly built frozen runtime and explicitly disposable profile paths"]
fn real_frozen_child_handshake() {
    let executable = std::env::var_os("STT_TEST_DESKTOP_RUNTIME_EXECUTABLE")
        .expect("explicit frozen candidate required");
    for key in [
        "STT_RUNTIME_STORAGE_PROFILES_FILE",
        "STT_RUNTIME_STORAGE_MASTER_KEY_FILE",
        "STT_RUNTIME_CANON_PROVIDER_PROFILES_FILE",
    ] {
        let path = PathBuf::from(std::env::var_os(key).expect("disposable profile path required"));
        assert!(path.is_absolute() && !path.exists());
    }
    let mut owned =
        OwnedRuntime::spawn(Path::new(&executable), Duration::from_secs(READY_SECONDS)).unwrap();
    assert!(owned.alive().unwrap());
    assert!(owned.connection.origin.starts_with("http://127.0.0.1:"));
    owned.stop(Duration::from_secs(STOP_SECONDS)).unwrap();
    assert!(!owned.alive().unwrap());
}
