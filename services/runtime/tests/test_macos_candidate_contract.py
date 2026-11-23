"""Manual arm64 DMG wiring; hosted/installed proof remains a separate gate."""
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[3]


def job():
    workflow = yaml.load((ROOT / ".github/workflows/macos-candidate.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(workflow["on"]) == {"pull_request", "workflow_dispatch"}
    assert workflow["permissions"] == {"contents": "read"}
    assert "secrets." not in str(workflow) and "continue-on-error" not in str(workflow)
    return workflow["jobs"]["macos-candidate"]


def test_native_arm64_minimum_and_explicit_signing_owner():
    definition = job()
    assert definition["runs-on"] == "macos-15"
    assert definition["env"]["MACOSX_DEPLOYMENT_TARGET"] == "15.0"
    script = "\n".join(step.get("run", "") for step in definition["steps"])
    for value in ['test "$(uname -m)" = arm64', 'minimumSystemVersion:"15.0"', "--frozen-lockfile", "--group build --locked",
                  "--bundles app --no-sign", '--config "$configuration" -- --locked', "macos_candidate.py finalize",
                  '--raw-runtime "$raw" --raw-manifest "$original"', "--no-skips", "real_frozen_child_handshake -- --ignored --exact"]:
        assert value in script
    assert script.index("scripts.build_desktop_runtime") < script.index("desktop-runtime-resources.mjs") < script.index("macos_candidate.py finalize")
    assert "perf:baseline" not in script and "gh release" not in script and "APPLE_API_KEY" not in script


def test_mounted_readonly_dmg_requires_signed_bytes_and_backend_probes_before_upload():
    script = "\n".join(step.get("run", "") for step in job()["steps"])
    for value in ["hdiutil create -fs HFS+", "hdiutil attach -readonly -nobrowse", 'trap \'hdiutil detach "$mount" || true\' EXIT',
                  "verifyCandidate(process.argv[1]", 'macos_candidate.py verify "$runtime"', 'env PATH=/nonexistent "$runtime/stt-runtime" --self-check',
                  'shasum -a 256 "$destination/SomethingToTellEngine-arm64.dmg"', 'signing:"adhoc",notarized:false,installed_gui_acceptance:"pending"']:
        assert value in script
    assert script.index("hdiutil create") < script.index("hdiutil attach") < script.index('macos_candidate.py verify "$runtime"')
    uploads = [step for step in job()["steps"] if step.get("uses") == "actions/upload-artifact@v4"]
    assert len(uploads) == 1
    assert "dist/macos-candidate" not in uploads[0]["with"]["path"]
    assert "${{ runner.temp }}/package-SHA256SUMS" in uploads[0]["with"]["path"]


def test_package_paths_match_the_engine_product_name():
    script = "\n".join(step.get("run", "") for step in job()["steps"])
    assert "bundle/macos/Something To Tell Engine.app" in script
    assert '$mount/Something To Tell Engine.app/Contents/Resources/runtime' in script
    assert '-volname "Something To Tell Engine"' in script
    assert "Something To Tell.app" not in script
    assert "SomethingToTell-arm64.dmg" not in script


def test_frontend_package_build_has_a_bounded_heap_budget():
    workflow = yaml.load((ROOT / ".github/workflows/macos-candidate.yml").read_text(), Loader=yaml.BaseLoader)
    definition = workflow["jobs"]["macos-candidate"]
    build = next(step for step in definition["steps"] if step.get("name") == "Build verified runtime and raw app")
    assert build["env"]["NODE_OPTIONS"] == "--max-old-space-size=4096"
    assert "NODE_OPTIONS" not in definition["env"]
