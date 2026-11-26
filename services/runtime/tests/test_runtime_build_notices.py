"""Build notices preserve actual bytes without inferring redistribution terms."""
from hashlib import sha256
import json
from types import SimpleNamespace

import pytest

from services.runtime.scripts import runtime_build_notices as notices


@pytest.fixture
def inputs(tmp_path, monkeypatch):
    (tmp_path / "LICENSE.txt").write_bytes(b"Copyright Example\r\nLicense fixture.\r\n")
    records = [(tmp_path, "LICENSE.txt", {"kind": "interpreter_installation"}),
               (tmp_path, "LICENSE.txt", {"kind": "build_tool", "name": "pyinstaller", "version": "6.22.3"})]
    monkeypatch.setattr(notices, "notice_inputs", lambda: iter(records))
    monkeypatch.setattr(notices, "collect_evidence", lambda *_: {"manifest_sha256": "a" * 64, "runtime": {"pyinstaller": "6.22.3"}})
    return tmp_path, records


def collect(inputs):
    root, _ = inputs
    return notices.collect_build_notices(root, root / "manifest.json")


def test_preserves_crlf_bytes_and_reports_both_groups_without_paths_or_approval(inputs):
    report = collect(inputs)
    assert not report["missing_notice_groups"] and report["distribution_approved"] is False
    raw = (inputs[0] / "LICENSE.txt").read_bytes()
    assert len(report["notice_texts"]) == 2
    assert all(item["text"].encode() == raw and item["sha256"] == sha256(raw).hexdigest() for item in report["notice_texts"])
    assert str(inputs[0]) not in json.dumps(report)


def test_missing_groups_remain_explicit(inputs):
    inputs[1].clear()
    assert collect(inputs)["missing_notice_groups"] == ["build_tool", "interpreter_installation"]


@pytest.mark.parametrize("limit", ["MAX_TEXT_BYTES", "MAX_TOTAL_BYTES"])
def test_bounds_text_reads(inputs, monkeypatch, limit):
    monkeypatch.setattr(notices, limit, 1)
    with pytest.raises(ValueError, match="text_limit"):
        collect(inputs)


@pytest.mark.parametrize("relative", ["../LICENSE.txt", "/absolute/LICENSE.txt", "C:/LICENSE.txt"])
def test_rejects_unsafe_paths(inputs, relative):
    inputs[1][0] = (inputs[0], relative, {"kind": "interpreter_installation"})
    with pytest.raises(ValueError, match="path_invalid"):
        collect(inputs)


def test_rejects_symlink_notice(inputs):
    root, records = inputs
    (root / "alias").symlink_to("LICENSE.txt")
    records[0] = (root, "alias", {"kind": "interpreter_installation"})
    with pytest.raises(ValueError, match="path_escape"):
        collect(inputs)


def test_rejects_tool_version_drift(inputs):
    inputs[1][1][2]["version"] = "changed"
    with pytest.raises(ValueError, match="version_changed"):
        collect(inputs)


def test_rejects_binary_notice(inputs):
    (inputs[0] / "LICENSE.txt").write_bytes(b"binary\0content")
    with pytest.raises(ValueError, match="not_text"):
        collect(inputs)


def test_original_candidate_verification_is_not_bypassed(inputs, monkeypatch):
    def reject(*_):
        raise ValueError("runtime_notice_candidate_mismatch")
    monkeypatch.setattr(notices, "collect_evidence", reject)
    with pytest.raises(ValueError, match="candidate_mismatch"):
        collect(inputs)


def test_enumerates_only_known_interpreter_and_recorded_tool_notice_names(tmp_path, monkeypatch):
    prefix = tmp_path / "python"
    prefix.mkdir()
    (prefix / "LICENSE.txt").write_text("license")
    monkeypatch.setattr(notices.sys, "base_prefix", str(prefix))
    monkeypatch.setattr(notices.sysconfig, "get_path", lambda _: str(prefix / "stdlib"))
    distribution = SimpleNamespace(version="6.22.3", files=["PyInstaller/COPYING.txt", "PyInstaller/code.py"], locate_file=lambda _: tmp_path)
    monkeypatch.setattr(notices.metadata, "distribution", lambda name: distribution)
    records = list(notices.notice_inputs())
    assert len(records) == 2
    assert records[0][1] == "LICENSE.txt" and records[1][1] == "PyInstaller/COPYING.txt"


def test_cli_outputs_json_only(inputs, monkeypatch, capsys):
    root, _ = inputs
    monkeypatch.setattr("sys.argv", ["build_notices", str(root), str(root / "manifest.json")])
    notices.main()
    assert json.loads(capsys.readouterr().out)["distribution_approved"] is False
