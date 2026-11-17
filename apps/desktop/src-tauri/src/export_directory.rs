//! A narrow OS file-manager boundary; artifact writes remain runtime-owned.
use std::path::{Path, PathBuf};
use std::process::Command;

fn existing_directory(directory: &str) -> Result<PathBuf, String> {
    let path = Path::new(directory);
    if !path.is_absolute() || !path.is_dir() {
        return Err("export_path_invalid".into());
    }
    path.canonicalize()
        .map_err(|_| "export_path_invalid".into())
}

#[tauri::command]
pub fn open_export_directory(directory: String) -> Result<(), String> {
    let path = existing_directory(&directory)?;
    // Passing a validated absolute path as an argument avoids shell expansion
    // and prevents option injection into the platform file manager.
    #[cfg(target_os = "macos")]
    let executable = "/usr/bin/open";
    #[cfg(target_os = "windows")]
    let executable = "explorer.exe";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let executable = "xdg-open";
    Command::new(executable)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|_| "export_directory_open_failed".into())
}

#[cfg(test)]
mod tests {
    use super::existing_directory;

    #[test]
    fn rejects_relative_missing_and_file_paths() {
        assert!(existing_directory("exports").is_err());
        assert!(existing_directory("/nonexistent-stt-export-directory").is_err());
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert!(existing_directory(source.to_str().unwrap()).is_err());
    }

    #[test]
    fn resolves_existing_absolute_directory() {
        let root = std::env::temp_dir();
        assert_eq!(
            existing_directory(root.to_str().unwrap()).unwrap(),
            root.canonicalize().unwrap()
        );
    }

    use std::path::PathBuf;
}
