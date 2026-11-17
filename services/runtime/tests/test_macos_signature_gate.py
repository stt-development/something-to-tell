"""Pure contract tests; actual codesign validation is a host-specific gate."""
import importlib.util
from hashlib import sha256
import json
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).parents[3]
spec = importlib.util.spec_from_file_location("macos_signatures", ROOT / "tools/macos_candidate.py")
signatures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signatures)


def test_runtime_verifies_every_macho_without_signing_or_parsing_captured_output(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    for index, header in enumerate(sorted(signatures.MACHO_HEADERS)):
        (runtime / str(index)).write_bytes(header + b"owned code")
    (runtime / "not-code").write_text("metadata")
    calls = []
    monkeypatch.setattr(signatures.subprocess, "run", lambda args, **kwargs: calls.append((args, kwargs)))
    assert signatures.verify_runtime_signatures(runtime) == 8
    assert len(calls) == 8
    for args, options in calls:
        assert args[:4] == ["/usr/bin/codesign", "--verify", "--strict", "--all-architectures"]
        assert "--sign" not in args and options["check"] is True and options["timeout"] == 30


def test_empty_or_invalid_signature_gate_fails_closed(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="no runtime"):
        signatures.verify_runtime_signatures(tmp_path)
    (tmp_path / "runtime").write_bytes(b"\xcf\xfa\xed\xfe")
    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "codesign")
    monkeypatch.setattr(signatures.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        signatures.verify_runtime_signatures(tmp_path)


def test_outer_app_verification_occurs_after_runtime_checks(tmp_path, monkeypatch):
    app = tmp_path / "Owned.app"
    runtime = app / "Contents/Resources/runtime"
    runtime.mkdir(parents=True)
    (runtime / "owned").write_bytes(b"\xcf\xfa\xed\xfe")
    calls = []
    monkeypatch.setattr(signatures.sys, "platform", "darwin")
    monkeypatch.setattr(signatures.subprocess, "run", lambda args, **kwargs: calls.append(args))
    assert signatures.main(["verify", str(runtime), "--app", str(app)]) == 0
    assert len(calls) == 2 and "--deep" not in calls[0] and "--deep" in calls[1]


def owned_bundle(tmp_path, monkeypatch):
    app = tmp_path / "Input.app"
    runtime = app / "Contents/Resources/runtime"
    runtime.mkdir(parents=True)
    (runtime / "code").write_bytes(b"\xcf\xfa\xed\xfeowned")
    (runtime / "metadata").write_bytes(b"unchanged metadata")
    manifest = tmp_path / "input.json"
    manifest.write_text(json.dumps({"files": [{"path": path.name, "bytes": path.stat().st_size,
        "sha256": sha256(path.read_bytes()).hexdigest()} for path in sorted(runtime.iterdir())]}))
    raw_manifest = tmp_path / "raw.json"
    raw_manifest.write_bytes(manifest.read_bytes())
    staged = json.loads(manifest.read_bytes())
    staged["normalization"] = {"source_manifest_sha256": sha256(raw_manifest.read_bytes()).hexdigest()}
    manifest.write_text(json.dumps(staged))
    observations = []
    def verify(directory, inventory):
        observations.append((directory, inventory))
        for item in json.loads(inventory.read_text())["files"]:
            if "symlink" in item:
                assert (directory / item["path"]).readlink().as_posix() == item["symlink"]
                continue
            assert sha256((directory / item["path"]).read_bytes()).hexdigest() == item["sha256"]
    monkeypatch.setattr(signatures, "verify_manifest", verify)
    return app, runtime, manifest, observations


def finalize(app, manifest, output):
    return signatures.finalize_candidate(app, manifest, output, raw_runtime=app / "Contents/Resources/runtime",
                                         raw_manifest=manifest.with_name("raw.json"))


def test_finalizer_copies_input_and_links_only_explicit_code_signature_changes(tmp_path, monkeypatch):
    app, runtime, manifest, observations = owned_bundle(tmp_path, monkeypatch)
    original = (runtime / "code").read_bytes()
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        if "--sign" in args and Path(args[-1]).is_file():
            path = Path(args[-1]); path.write_bytes(path.read_bytes() + b"signature")
    monkeypatch.setattr(signatures.subprocess, "run", run)
    result = finalize(app, manifest, tmp_path / "output")
    assert (runtime / "code").read_bytes() == original
    signed = json.loads(Path(result["manifest"]).read_text())
    transform = signed["signing_transform"]
    assert transform["staged_manifest_sha256"] == sha256(manifest.read_bytes()).hexdigest()
    assert transform["changed_paths"] == ["code"] and transform["code_paths"] == ["code"]
    assert result["runtime_macho_files"] == 1 and result["changed_runtime_files"] == 1
    assert Path(result["staged_manifest"]).read_bytes() == manifest.read_bytes()
    assert len(observations) == 5  # Staged, raw input, raw copy, post-sign, outer.
    assert "--sign" in calls[0] and "--verify" in calls[1]
    assert "--sign" in calls[2] and "--deep" in calls[3]
    assert "--deep" not in calls[0] and "--deep" not in calls[2]


@pytest.mark.parametrize("tamper", ["resource", "permissions", "inventory"])
def test_finalizer_rejects_non_signature_changes_without_touching_input(tmp_path, monkeypatch, tamper):
    app, runtime, manifest, _ = owned_bundle(tmp_path, monkeypatch)
    def run(args, **kwargs):
        if "--sign" not in args:
            return
        code = Path(args[-1])
        if tamper == "resource":
            (code.parent / "metadata").write_bytes(b"tampered")
        elif tamper == "permissions":
            code.chmod(0o400)
        else:
            (code.parent / "extra").write_bytes(b"unexpected")
    monkeypatch.setattr(signatures.subprocess, "run", run)
    with pytest.raises(ValueError, match="signing changed"):
        finalize(app, manifest, tmp_path / "output")
    assert (runtime / "metadata").read_bytes() == b"unchanged metadata"
    assert not (runtime / "extra").exists()


def test_original_manifest_rejection_happens_before_any_output_or_signing(tmp_path, monkeypatch):
    app, _, manifest, _ = owned_bundle(tmp_path, monkeypatch)
    def reject(*args):
        raise ValueError("original validation rejected")
    monkeypatch.setattr(signatures, "verify_manifest", reject)
    monkeypatch.setattr(signatures.subprocess, "run", lambda *args, **kwargs: pytest.fail("unexpected signing"))
    with pytest.raises(ValueError, match="original validation"):
        finalize(app, manifest, tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_signature_resources_are_limited_to_actual_framework_envelopes():
    frames = [Path("Python.framework")]
    assert signatures.signature_envelope("Python.framework/_CodeSignature/CodeResources", frames)
    assert signatures.signature_envelope("Python.framework/Versions/3.13/_CodeSignature/CodeResources", frames)
    for invalid in ["_CodeSignature/CodeResources", "Other.framework/_CodeSignature/CodeResources",
                    "Python.framework/random/_CodeSignature/CodeResources", "Python.framework/_CodeSignature/metadata"]:
        assert not signatures.signature_envelope(invalid, frames)


def test_finalizer_rejects_unlinked_raw_manifest_before_copying(tmp_path, monkeypatch):
    app, _, manifest, _ = owned_bundle(tmp_path, monkeypatch)
    manifest.with_name("raw.json").write_text("{}")
    with pytest.raises(ValueError, match="linkage mismatch"):
        finalize(app, manifest, tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_raw_internal_aliases_are_preserved_instead_of_materialized(tmp_path, monkeypatch):
    app, _, manifest, _ = owned_bundle(tmp_path, monkeypatch)
    raw = tmp_path / "raw-runtime"
    signatures.shutil.copytree(app / "Contents/Resources/runtime", raw)
    (raw / "alias").symlink_to("code")
    raw_manifest = manifest.with_name("raw.json")
    raw_manifest.write_text(json.dumps({"files": signatures.inventory(raw)}))
    staged = json.loads(manifest.read_text())
    staged["normalization"]["source_manifest_sha256"] = sha256(raw_manifest.read_bytes()).hexdigest()
    manifest.write_text(json.dumps(staged))
    def run(args, **kwargs):
        path = Path(args[-1])
        if "--sign" in args and path.is_file():
            path.write_bytes(path.read_bytes() + b"signature")
    monkeypatch.setattr(signatures.subprocess, "run", run)
    result = signatures.finalize_candidate(app, manifest, tmp_path / "output", raw_runtime=raw, raw_manifest=raw_manifest)
    alias = Path(result["app"]) / "Contents/Resources/runtime/alias"
    assert alias.is_symlink() and alias.readlink() == Path("code")
    signed = json.loads(Path(result["manifest"]).read_text())
    assert next(item for item in signed["files"] if item["path"] == "alias") == {"path": "alias", "symlink": "code"}
