"""Linux job contracts do not claim real Ubuntu or SteamOS acceptance."""
from pathlib import Path
import json
import shlex
import subprocess
import sys

import yaml

ROOT = Path(__file__).parents[3]


def definition():
    workflow = yaml.load((ROOT / ".github/workflows/linux-candidate.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(workflow["on"]) == {"pull_request", "workflow_dispatch"}
    assert workflow["permissions"] == {"contents": "read"}
    assert "secrets." not in str(workflow) and "continue-on-error" not in str(workflow)
    return workflow["jobs"]["linux-candidate"]


def commands():
    return "\n".join(step.get("run", "") for step in definition()["steps"])


def test_native_locked_linux_build_includes_real_prerequisites_and_probes():
    assert definition()["runs-on"] == "ubuntu-24.04"
    script = commands()
    for value in ['test "$(uname -m)" = x86_64', "getconf GNU_LIBC_VERSION", "libwebkit2gtk-4.1-dev", "libfuse2t64",
                  "--frozen-lockfile", "--group build --locked", "--no-skips", "real_frozen_child_handshake -- --ignored --exact",
                  'tauri build --verbose --bundles appimage deb --config "$STT_RUNTIME_CONFIGURATION" -- --locked']:
        assert value in script
    assert script.index("scripts.build_desktop_runtime") < script.index("desktop-runtime-resources.mjs") < script.index("tauri build")
    assert "perf:baseline" not in script and "benchmark_storage" not in script


def test_both_extracted_candidates_must_match_original_staged_bytes_and_execute():
    script = commands()
    for value in ["--appimage-extract", "dpkg-deb --extract", 'test "${#runtimes[@]}" = 1', 'test -x "$runtime"',
                  'verifyCandidate(process.argv[1]', 'ldd "$runtime"', "grep -q 'not found'", 'env PATH=/nonexistent "$runtime" --self-check',
                  'probe appimage "$RUNNER_TEMP/appimage-extracted/squashfs-root"', 'probe deb "$RUNNER_TEMP/deb-extracted"']:
        assert value in script
    assert script.index("probe deb") < script.index('sha256sum "$image" "$package"')
    assert 'ubuntu_installed_acceptance:"pending",steamos_acceptance:"pending"' in script
    assert "gh release" not in script and "steamcmd" not in script
    uploads = [step for step in definition()["steps"] if step.get("uses") == "actions/upload-artifact@v4"]
    assert len(uploads) == 1
    assert "dist/linux-candidate" not in uploads[0]["with"]["path"]
    assert "${{ runner.temp }}/package-SHA256SUMS" in uploads[0]["with"]["path"]


def test_packaging_discovers_manifest_library_directories_without_changing_probes(tmp_path):
    script = commands()
    line = next(line.strip() for line in script.splitlines() if "library_path=$(uv run python -c " in line)
    # Execute the actual workflow expression, not a duplicate path implementation.
    program = shlex.split(line.removeprefix("library_path=$(uv run python -c "))[0]
    root = tmp_path / "runtime with spaces"
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"files": [
        {"path": "_internal/libssl-hashed.so.3"},
        {"path": "_internal/wheel.libs/libcrypto-hashed.so.3"},
        {"path": "_internal/wheel.libs/libother.so"},
        {"path": "_internal/module/extension.so"},
        {"path": "_internal/metadata/notice.txt"},
    ]}))
    result = subprocess.run([sys.executable, "-c", program, str(root), str(manifest)],
                            check=True, capture_output=True, text=True)
    assert result.stdout.strip().split(":") == sorted([
        str(root / "_internal"), str(root / "_internal/wheel.libs"), str(root / "_internal/module"),
    ])
    assert 'test -n "$library_path"' in script
    assert 'LD_LIBRARY_PATH="$library_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" pnpm' in script
    assert "LD_LIBRARY_PATH" not in definition().get("env", {})
    assert script.count("LD_LIBRARY_PATH=") == 1


def test_finalized_image_is_repacked_before_unchanged_extracted_integrity_probes():
    script = commands()
    for value in ["node --test tools/linux-runtime-finalizer.test.mjs", "node tools/linux-runtime-finalizer.mjs",
                  'test "${#appdirs[@]}" = 1', 'LDAI_OUTPUT="$output" ARCH=x86_64 "$plugin" --appdir "$appdir"',
                  'image="$STT_VERIFIED_APPIMAGE"', '"$image" --appimage-extract']:
        assert value in script
    assert script.index("tauri build") < script.index("node tools/linux-runtime-finalizer.mjs")
    assert script.index("node tools/linux-runtime-finalizer.mjs") < script.index('probe appimage')
    assert script.index('probe appimage') < script.index('sha256sum "$image" "$package"')
