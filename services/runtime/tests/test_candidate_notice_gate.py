"""Build verification cannot distribute binaries while the notice audit is pending."""
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).parents[3]


@pytest.mark.parametrize("platform", ["windows", "macos", "linux"])
def test_native_verification_can_upload_only_explicit_diagnostic_files(platform):
    workflow = yaml.load((ROOT / f".github/workflows/{platform}-candidate.yml").read_text(), Loader=yaml.BaseLoader)
    steps = workflow["jobs"][f"{platform}-candidate"]["steps"]
    assert set(workflow["on"]) == {"pull_request", "workflow_dispatch"}
    assert workflow["permissions"] == {"contents": "read"}
    uploads = [step for step in steps if step.get("uses") == "actions/upload-artifact@v4"]
    assert len(uploads) == 1
    assert uploads[0]["if"] == "always()"
    # Closed allowlist: neither an output directory nor a wildcard can hide a binary.
    allowed = {
        "frozen.xml", "runtime-manifest.json", "source-manifest.json",
        "input-runtime-manifest.json", "staged-runtime-manifest.json",
        "package-verification.json", "package-SHA256SUMS", "appimage-ldd.txt", "deb-ldd.txt",
        "runtime-notice-evidence.json",
    }
    paths = uploads[0]["with"]["path"].splitlines()
    assert paths
    for path in paths:
        assert path.startswith("${{ runner.temp }}/")
        assert path.removeprefix("${{ runner.temp }}/") in allowed
    assert "${{ runner.temp }}/runtime-manifest.json" in paths
    assert "${{ runner.temp }}/package-verification.json" in paths
    assert "pull_request_target" not in workflow["on"]
    assert "release" not in workflow["on"] and "push" not in workflow["on"]
    assert workflow["concurrency"]["cancel-in-progress"] == "true"


@pytest.mark.parametrize("platform", ["windows", "macos", "linux"])
def test_native_jobs_collect_only_raw_verified_notice_evidence(platform):
    workflow = yaml.load((ROOT / f".github/workflows/{platform}-candidate.yml").read_text(), Loader=yaml.BaseLoader)
    steps = workflow["jobs"][f"{platform}-candidate"]["steps"]
    script = "\n".join(step.get("run", "") for step in steps)
    package_command = "tauri.js build" if platform == "windows" else "tauri build"
    assert script.index("tools/desktop-runtime-resources.mjs") < script.index("scripts.runtime_notice_evidence") < script.index(package_command)
    assert "uv run --group build python -m services.runtime.scripts.runtime_notice_evidence" in script
    if platform == "windows":
        assert "$built.candidate $built.manifest" in script
        assert "throw 'runtime notice evidence failed'" in script
    else:
        assert '\"$raw\" \"$(dirname \"$raw\")/manifest.json\"' in script
    upload = next(step for step in steps if step.get("uses") == "actions/upload-artifact@v4")
    assert "${{ runner.temp }}/runtime-notice-evidence.json" in upload["with"]["path"].splitlines()
