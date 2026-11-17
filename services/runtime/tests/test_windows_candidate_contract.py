"""Manual Windows candidate definition, not evidence of a Windows build/run."""
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[3]


def candidate():
    return yaml.load((ROOT / ".github/workflows/windows-candidate.yml").read_text(), Loader=yaml.BaseLoader)


def commands():
    return "\n".join(step.get("run", "") for step in candidate()["jobs"]["windows-candidate"]["steps"])


def test_candidate_is_manual_native_x64_and_cannot_publish_release():
    workflow = candidate()
    assert set(workflow["on"]) == {"workflow_dispatch"}
    assert workflow["permissions"] == {"contents": "read"}
    job = workflow["jobs"]["windows-candidate"]
    assert job["runs-on"] == "windows-2025"
    assert job["defaults"]["run"]["shell"] == "pwsh"
    assert "OSArchitecture -ne 'X64'" in commands()
    assert "secrets." not in str(workflow)
    assert "continue-on-error" not in str(workflow)
    assert "gh release" not in commands() and "tauri-action" not in str(workflow)


def test_candidate_builds_verified_runtime_before_probes_and_nsis():
    script = commands()
    sequence = ["--frozen-lockfile", "--group build --locked", "scripts.build_desktop_runtime",
                "tools/desktop-runtime-resources.mjs", "--self-check", "test_desktop_lifecycle.py",
                "real_frozen_child_handshake -- --ignored --exact", "tauri icon", "tauri build --bundles nsis"]
    positions = [script.index(value) for value in sequence]
    assert positions == sorted(positions)
    assert "no-developer-tools" in script and "finally { $env:PATH = $previousPath }" in script
    assert "check-ci-test-report.py" in script and "--no-skips" in script
    assert "cargo test --locked" in script
    assert "--config $env:STT_RUNTIME_STAGE -- --locked" in script
    assert script.count("ConvertFrom-Json") >= 3
    assert "type = 'offlineInstaller'" in script and "icon.ico" in script
    assert "perf:baseline" not in script and "benchmark_storage" not in script


def test_candidate_preserves_provenance_license_and_non_recursive_checksums():
    script = commands()
    for value in ["Copy-Item LICENSE", "runtime-manifest.json", "source-manifest.json", "source_commit = $env:GITHUB_SHA",
                  "runner_image = $env:ImageVersion", "windows_11_acceptance = 'pending'", "signed = $false"]:
        assert value in script
    assert script.index("$hashes = @(") < script.index('$hashes | Set-Content')
    assert "Get-FileHash $_.FullName -Algorithm SHA256" in script
    uploads = [step for step in candidate()["jobs"]["windows-candidate"]["steps"] if step.get("uses") == "actions/upload-artifact@v4"]
    assert len(uploads) == 2
    assert uploads[0]["with"]["path"] == "dist/windows-candidate"
    assert uploads[0]["with"]["if-no-files-found"] == "error"
