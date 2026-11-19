"""Linux job contracts do not claim real Ubuntu or SteamOS acceptance."""
from pathlib import Path

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
