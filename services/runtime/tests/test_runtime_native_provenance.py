"""Native attribution needs exact bytes and never leaks host paths or approvals."""
from hashlib import sha256
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.runtime.scripts import runtime_native_provenance as provenance


@pytest.fixture
def case(tmp_path, monkeypatch):
    candidate, source = tmp_path / "candidate", tmp_path / "private-build-inputs"
    candidate.mkdir()
    source.mkdir()
    content = b"synthetic native fixture"
    (candidate / "module.so").write_bytes(content)
    (source / "original.so").write_bytes(content)
    item = {"path": "module.so", "bytes": len(content), "sha256": sha256(content).hexdigest()}
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}")
    evidence = {"manifest_sha256": "a" * 64, "runtime": {"system": "Test"},
                "native_files": [item, {"path": "alias.so", "symlink": "module.so"}]}
    inputs = [(source, "original.so", {"kind": "installed_distribution", "name": "example", "version": "1.2"})]
    monkeypatch.setattr(provenance, "collect_evidence", lambda *_: evidence)
    monkeypatch.setattr(provenance, "input_files", lambda: iter(inputs))
    return SimpleNamespace(candidate=candidate, source=source, manifest=manifest, inputs=inputs, evidence=evidence)


def collect(case):
    return provenance.collect_provenance(case.candidate, case.manifest)


def test_exact_match_preserves_identity_but_not_host_paths_or_binary_content(case):
    report = collect(case)
    assert report["files"][0]["status"] == "exact_build_input_match"
    assert report["files"][0]["origins"] == [{"kind": "installed_distribution", "name": "example", "version": "1.2", "relative_path": "original.so"}]
    assert len(report["files"]) == 1
    assert report["distribution_approved"] is False
    assert report["manifest_sha256"] == "a" * 64
    assert report["review_gaps"]
    assert str(case.source) not in json.dumps(report)
    assert "synthetic native fixture" not in json.dumps(report)


@pytest.mark.parametrize("content", [b"same length wrong bytes!", b"different size"])
def test_unmatched_input_is_not_guessed_from_filename(case, content):
    (case.source / "original.so").write_bytes(content)
    record = collect(case)["files"][0]
    assert record["status"] == "unmatched_or_transformed" and record["origins"] == []


def test_stale_original_manifest_rejection_propagates_before_reading_sources(case, monkeypatch):
    def reject(*_):
        raise ValueError("runtime_notice_candidate_mismatch")
    monkeypatch.setattr(provenance, "collect_evidence", reject)
    monkeypatch.setattr(provenance, "input_files", lambda: pytest.fail("must not inspect build inputs"))
    with pytest.raises(ValueError, match="candidate_mismatch"):
        collect(case)


def test_rechecks_native_candidate_after_manifest_gate(case):
    (case.candidate / "module.so").write_bytes(b"tampered native fixture!")
    with pytest.raises(ValueError, match="candidate_changed|input_changed"):
        collect(case)


@pytest.mark.parametrize("relative", ["../outside.so", "/private/absolute.so", "C:/absolute.dll", "invalid\n.so"])
def test_rejects_unsafe_input_paths(case, relative):
    case.inputs[0] = (case.source, relative, {})
    with pytest.raises(ValueError, match="source_path_invalid"):
        collect(case)


def test_rejects_source_symlink_escape(case, tmp_path):
    outside = tmp_path / "outside.so"
    outside.write_bytes(b"outside")
    link = case.source / "escape.so"
    link.symlink_to(outside)
    case.inputs[0] = (case.source, "escape.so", {})
    with pytest.raises(ValueError, match="source_escape"):
        collect(case)


@pytest.mark.parametrize("limit", ["MAX_FILE_BYTES", "MAX_SOURCE_BYTES"])
def test_enforces_bounded_input_reads(case, monkeypatch, limit):
    monkeypatch.setattr(provenance, limit, 1)
    with pytest.raises(ValueError, match="limit"):
        collect(case)


def test_preserves_multiple_owners_and_deduplicates_repeated_inventory_entries(case):
    case.inputs.extend([case.inputs[0], (case.source, "original.so", {"kind": "interpreter_installation"})])
    assert len(collect(case)["files"][0]["origins"]) == 2


def test_file_digest_detects_truncated_source(case):
    with pytest.raises(ValueError, match="input_changed"):
        provenance.file_digest(case.source / "original.so", 100)


def test_cli_returns_only_evidence_json(case, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["native_provenance", str(case.candidate), str(case.manifest)])
    provenance.main()
    assert json.loads(capsys.readouterr().out)["distribution_approved"] is False


def test_inventory_reads_records_and_known_interpreter_directories_without_importing_packages(tmp_path, monkeypatch):
    prefix = tmp_path / "interpreter"
    (prefix / "lib").mkdir(parents=True)
    (prefix / "lib/libpython3.so").write_bytes(b"native")
    distribution = SimpleNamespace(metadata={"Name": "example"}, version="1.2",
        files=[Path("module.so"), Path("module.py"), Path("../../Scripts/entry.exe")], locate_file=lambda _: tmp_path)
    monkeypatch.setattr(provenance.metadata, "distributions", lambda: [distribution])
    monkeypatch.setattr(provenance.sys, "base_prefix", str(prefix))
    monkeypatch.setattr(provenance.sysconfig, "get_path", lambda _: str(prefix / "stdlib"))
    inputs = list(provenance.input_files())
    assert len(inputs) == 2
    assert inputs[0][1:] == ("module.so", {"kind": "installed_distribution", "name": "example", "version": "1.2"})
    assert inputs[1][1:] == ("lib/libpython3.so", {"kind": "interpreter_installation"})


def test_interpreter_inventory_accepts_homebrew_style_prefix_alias(tmp_path, monkeypatch):
    prefix = tmp_path / "actual"
    directory = prefix / "lib/python3.13/lib-dynload"
    directory.mkdir(parents=True)
    (directory / "_ssl.so").write_bytes(b"native")
    alias = tmp_path / "alias"
    alias.symlink_to(prefix, target_is_directory=True)
    monkeypatch.setattr(provenance.metadata, "distributions", lambda: [])
    monkeypatch.setattr(provenance.sys, "base_prefix", str(prefix))
    monkeypatch.setattr(provenance.sysconfig, "get_path", lambda _: str(alias / "lib/python3.13"))
    assert list(provenance.input_files()) == [(prefix, "lib/python3.13/lib-dynload/_ssl.so", {"kind": "interpreter_installation"})]
