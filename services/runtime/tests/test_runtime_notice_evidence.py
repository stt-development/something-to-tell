"""Evidence collection is bounded, tied to actual candidate bytes and never approval."""

from hashlib import sha256
import json
from pathlib import Path

import pytest

from services.runtime.scripts import runtime_notice_evidence as evidence
from services.runtime.scripts.build_desktop_runtime import artifact_manifest


@pytest.fixture
def candidate(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    root.mkdir()
    metadata = root / "_internal/example-1.2.dist-info"
    metadata.mkdir(parents=True)
    (metadata / "METADATA").write_text("Name: example\nVersion: 1.2\nLicense-Expression: MIT\nLicense-File: LICENSE\n\nExample\n")
    (metadata / "LICENSE").write_text("Example license: copyright preserved.\n", encoding="utf-8")
    (root / "stt-runtime").write_bytes(b"native executable must never appear as text")
    files = [{"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size,
              "sha256": sha256(path.read_bytes()).hexdigest()} for path in sorted(root.rglob("*")) if path.is_file()]
    manifest = {"schema_version": 1, "system": "Test", "machine": "test", "python": "3.13",
                "pyinstaller": "test", "lock_sha256": "a" * 64, "sources": [], "files": files}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    # The existing recipe owns complete integrity/provenance; these tests isolate
    # notice reads and also exercise rejection when that comparison differs.
    monkeypatch.setattr(evidence, "artifact_manifest", lambda _root: manifest)
    return root, path, manifest


def test_collects_declared_text_and_native_hashes_without_binary_or_host_paths(candidate):
    root, manifest, _ = candidate
    result = evidence.collect_evidence(root, manifest)
    assert result["distribution_approved"] is False
    assert result["distributions"][0]["name"] == "example"
    assert result["distributions"][0]["license_expression"] == "MIT"
    assert result["distributions"][0]["declared_license_files"] == ["LICENSE"]
    assert result["notice_texts"][0]["text"] == "Example license: copyright preserved.\n"
    assert result["native_files"][0]["path"] == "stt-runtime"
    assert str(root) not in json.dumps(result)
    assert "native executable" not in json.dumps(result)
    assert len(result["review_gaps"]) == 4


def test_rejects_stale_candidate_provenance_before_any_notice_read(candidate, monkeypatch):
    root, manifest, _ = candidate
    monkeypatch.setattr(evidence, "artifact_manifest", lambda _root: {})
    with pytest.raises(ValueError, match="candidate_mismatch"):
        evidence.collect_evidence(root, manifest)


@pytest.mark.parametrize("tamper", [False, True])
def test_integrates_with_original_recipe_manifest_verification(candidate, monkeypatch, tamper):
    root, manifest, _ = candidate
    manifest.write_text(json.dumps(artifact_manifest(root)))
    monkeypatch.setattr(evidence, "artifact_manifest", artifact_manifest)
    if tamper:
        (root / "stt-runtime").write_bytes(b"changed runtime")
        with pytest.raises(ValueError, match="candidate_mismatch"):
            evidence.collect_evidence(root, manifest)
    else:
        assert evidence.collect_evidence(root, manifest)["distributions"][0]["name"] == "example"


def test_rechecks_notice_bytes_after_initial_manifest_verification(candidate):
    root, manifest, _ = candidate
    (root / "_internal/example-1.2.dist-info/LICENSE").write_text("changed")
    with pytest.raises(ValueError, match="content_changed"):
        evidence.collect_evidence(root, manifest)


@pytest.mark.parametrize("limit", ["MAX_TEXT_BYTES", "MAX_TOTAL_BYTES"])
def test_rejects_oversized_text_or_aggregate(candidate, monkeypatch, limit):
    root, manifest, _ = candidate
    monkeypatch.setattr(evidence, limit, 5)
    with pytest.raises(ValueError, match="text_limit"):
        evidence.collect_evidence(root, manifest)


def test_rejects_symlink_notice_even_when_target_is_internal(candidate):
    root, manifest, _ = candidate
    path = root / "_internal/example-1.2.dist-info/LICENSE"
    path.unlink()
    try:
        path.symlink_to("METADATA")
    except OSError:
        pytest.skip("Host cannot create symlink fixtures")
    with pytest.raises(ValueError, match="path_escape"):
        evidence.collect_evidence(root, manifest)


def test_reports_missing_license_without_inventing_approval_or_text(candidate):
    root, manifest, report = candidate
    (root / "_internal/example-1.2.dist-info/LICENSE").unlink()
    report["files"] = [item for item in report["files"] if not item["path"].endswith("/LICENSE")]
    manifest.write_text(json.dumps(report))
    result = evidence.collect_evidence(root, manifest)
    assert result["notice_texts"] == []
    assert result["distributions_without_notice_text"] == ["_internal/example-1.2.dist-info/METADATA"]
    assert result["distribution_approved"] is False


@pytest.mark.parametrize("content,error", [(b"binary\x00bytes", "not_text"), (b"\xff", None)])
def test_rejects_non_text_notice_contents(candidate, content, error):
    root, manifest, report = candidate
    path = root / "_internal/example-1.2.dist-info/LICENSE"
    path.write_bytes(content)
    entry = next(item for item in report["files"] if item["path"].endswith("/LICENSE"))
    entry.update(bytes=len(content), sha256=sha256(content).hexdigest())
    manifest.write_text(json.dumps(report))
    with pytest.raises(ValueError, match=error):
        evidence.collect_evidence(root, manifest)


def test_rejects_metadata_missing_required_identity(candidate):
    root, manifest, report = candidate
    path = root / "_internal/example-1.2.dist-info/METADATA"
    path.write_text("Version: 1.2\n\n")
    entry = next(item for item in report["files"] if item["path"].endswith("/METADATA"))
    entry.update(bytes=path.stat().st_size, sha256=sha256(path.read_bytes()).hexdigest())
    manifest.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="metadata_invalid"):
        evidence.collect_evidence(root, manifest)


def test_cli_emits_only_the_json_evidence(candidate, monkeypatch, capsys):
    root, manifest, _ = candidate
    monkeypatch.setattr("sys.argv", ["runtime_notice_evidence", str(root), str(manifest)])
    evidence.main()
    result = json.loads(capsys.readouterr().out)
    assert result["distribution_approved"] is False
    assert result["manifest_sha256"] == sha256(manifest.read_bytes()).hexdigest()
