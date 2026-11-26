"""Source-only notice archives preserve bytes and never imply binary approval."""

from hashlib import sha256
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools import assemble_runtime_notices as notices

ROOT = Path(__file__).parents[3]


def store_report(case, system, report):
    data = json.dumps(report, indent=2).encode("utf-8")
    case.reports[system].write_bytes(data)
    receipts = json.loads(case.receipts.read_bytes())
    receipts["reports"][system]["sha256"] = sha256(data).hexdigest()
    case.receipts.write_text(json.dumps(receipts), encoding="utf-8")


def rebind_lock(case):
    raw = case.lock.read_bytes().replace(b"\r\n", b"\n")
    for system, path in case.reports.items():
        report = json.loads(path.read_bytes())
        report["runtime"]["lock_sha256"] = sha256(raw.replace(b"\n", b"\r\n") if system == "Windows" else raw).hexdigest()
        store_report(case, system, report)


@pytest.fixture
def case(tmp_path):
    case = SimpleNamespace(lock=tmp_path / "uv.lock", receipts=tmp_path / "inputs.json",
                           reports={system: tmp_path / f"{system}.json" for system in notices.SYSTEMS},
                           output=tmp_path / "archive")
    case.lock.write_text('version = 1\n[[package]]\nname = "example-pkg"\nversion = "1.2"\n'
        '[package.sdist]\nurl = "https://files.pythonhosted.org/packages/example.tar.gz"\n'
        f'hash = "sha256:{"a" * 64}"\n', encoding="utf-8")
    receipts = {"schema_version": 1, "source_head_commit": "1" * 40, "build_merge_commit": "2" * 40,
                "reports": {system: {"run_url": "https://github.com/example/project/actions/runs/1", "sha256": "0" * 64} for system in notices.SYSTEMS}}
    case.receipts.write_text(json.dumps(receipts), encoding="utf-8")
    for system in notices.SYSTEMS:
        text = "Copyright \N{COPYRIGHT SIGN} Example\nPermission notice.\n"
        if system == "Windows":
            text = text.replace("\n", "\r\n")
        path = "_internal/example_pkg-1.2.dist-info/LICENSE"
        report = {"schema_version": 1, "scope": "raw_runtime_notice_evidence_only", "distribution_approved": False,
            "collector_sha256": "b" * 64, "manifest_sha256": "c" * 64,
            "runtime": {"system": system, "machine": "test", "python": "3.13", "pyinstaller": "test", "lock_sha256": "0" * 64},
            "review_gaps": ["native_source_review"],
            "notice_texts": [{"path": path, "sha256": sha256(text.encode()).hexdigest(), "text": text}],
            "distributions": [{"name": "Example_Pkg", "version": "1.2", "metadata_path": "_internal/example_pkg-1.2.dist-info/METADATA",
                "license_expression": "MIT", "license_declaration": "", "bundled_notice_paths": [path]}]}
        store_report(case, system, report)
    rebind_lock(case)
    return case


def assemble(case):
    return notices.assemble(case.lock, case.receipts, case.reports, case.output)


def test_preserves_notice_bytes_and_exact_locked_references_without_approval(case):
    result = assemble(case)
    assert result["distribution_approved"] is False
    assert len(result["packages"]) == 1 and len(result["license_texts"]) == 2
    package = result["packages"][0]
    assert package["name"] == "example-pkg"
    assert package["source_archive"]["sha256"] == "a" * 64
    assert package["source_archive"]["status"] == "locked_reference_only_not_downloaded_or_verified"
    for item in package["evidence"]:
        original = json.loads(case.reports[item["platform"]].read_bytes())["notice_texts"][0]["text"].encode()
        assert (case.output / item["notices"][0]["file"]).read_bytes() == original
    assert str(case.output.parent) not in (case.output / "index.json").read_text()
    assert "not a complete" in (case.output / "README.md").read_text()


def test_rejects_unreviewed_report_changes_before_creating_output(case):
    case.reports["Linux"].write_bytes(case.reports["Linux"].read_bytes() + b"\n")
    with pytest.raises(ValueError, match="report_digest_changed"):
        assemble(case)
    assert not case.output.exists()


@pytest.mark.parametrize("change,error", [
    ("text", "text_digest_changed"), ("approval", "scope_invalid"),
    ("platform", "platform_or_lock_changed"), ("path", "path_invalid"),
    ("metadata", "metadata_path_invalid"), ("gaps", "review_gaps_missing")])
def test_rejects_invalid_evidence_even_with_updated_receipt(case, change, error):
    report = json.loads(case.reports["Linux"].read_bytes())
    if change == "text": report["notice_texts"][0]["text"] = "modified"
    if change == "approval": report["distribution_approved"] = True
    if change == "platform": report["runtime"]["system"] = "Windows"
    if change == "path": report["notice_texts"][0]["path"] = "../LICENSE"
    if change == "metadata": report["distributions"].append(report["distributions"][0])
    if change == "gaps": report["review_gaps"] = []
    store_report(case, "Linux", report)
    with pytest.raises(ValueError, match=error): assemble(case)
    assert not case.output.exists()


def test_rejects_cross_package_notice_association(case):
    report = json.loads(case.reports["Linux"].read_bytes())
    report["notice_texts"][0]["path"] = "_internal/other-1.2.dist-info/LICENSE"
    report["distributions"][0]["bundled_notice_paths"] = [report["notice_texts"][0]["path"]]
    store_report(case, "Linux", report)
    with pytest.raises(ValueError, match="distribution_reference_invalid"): assemble(case)


def test_rejects_lock_drift_but_reproduces_identical_output_for_crlf(case, tmp_path):
    assemble(case)
    before = (case.output / "index.json").read_bytes()
    case.output = tmp_path / "crlf-output"
    case.lock.write_bytes(case.lock.read_bytes().replace(b"\n", b"\r\n"))
    assemble(case)
    assert (case.output / "index.json").read_bytes() == before
    case.output = tmp_path / "stale-output"
    case.lock.write_bytes(case.lock.read_bytes() + b"# changed\r\n")
    with pytest.raises(ValueError, match="platform_or_lock_changed"): assemble(case)


@pytest.mark.parametrize("missing", ["lock_record", "sdist"])
def test_records_missing_sources_instead_of_guessing_vendored_versions(case, missing):
    if missing == "lock_record":
        case.lock.write_text("version = 1\npackage = []\n")
    else:
        case.lock.write_text(case.lock.read_text().split("[package.sdist]")[0])
    rebind_lock(case)
    package = assemble(case)["packages"][0]
    assert package["source_archive"] is None
    assert package["review_gaps"] == (["distribution_not_in_lock_including_vendored_records"] if missing == "lock_record" else ["locked_distribution_has_no_sdist"])


def test_does_not_export_credentialed_or_nonpublic_source_urls(case):
    case.lock.write_text(case.lock.read_text().replace("https://files.pythonhosted.org", "https://user:secret@example.test"))
    rebind_lock(case)
    with pytest.raises(ValueError, match="source_url_not_public"): assemble(case)
    assert not case.output.exists()


def test_preserves_missing_notice_and_declaration_review_gaps(case):
    report = json.loads(case.reports["Linux"].read_bytes())
    report["distributions"][0].update(bundled_notice_paths=[], license_expression="")
    store_report(case, "Linux", report)
    gaps = assemble(case)["packages"][0]["review_gaps"]
    assert "bundled_notice_text_missing" in gaps
    assert "license_declaration_missing_requires_text_review" in gaps


def test_refuses_overwriting_an_existing_archive(case):
    case.output.mkdir()
    sentinel = case.output / "keep.txt"
    sentinel.write_text("existing work")
    with pytest.raises(FileExistsError): assemble(case)
    assert sentinel.read_text() == "existing work"
    assert sorted(path.name for path in case.output.iterdir()) == ["keep.txt"]


@pytest.mark.parametrize("limit", ["MAX_REPORT_BYTES", "MAX_TEXT_BYTES"])
def test_bounds_report_and_text_sizes(case, monkeypatch, limit):
    monkeypatch.setattr(notices, limit, 1)
    with pytest.raises(ValueError, match="too_large|text_invalid"): assemble(case)
    assert not case.output.exists()


def test_cli_reports_counts_not_license_text_or_binary_approval(case, monkeypatch, capsys):
    arguments = ["assemble_runtime_notices", "--lock", str(case.lock), "--receipts", str(case.receipts), "--output", str(case.output)]
    for system, path in case.reports.items(): arguments.extend([f"--{system.lower()}", str(path)])
    monkeypatch.setattr("sys.argv", arguments)
    notices.main()
    assert json.loads(capsys.readouterr().out) == {"packages": 1, "license_texts": 2, "distribution_approved": False}


def test_rejects_ambiguous_locked_source_identity(case):
    original = case.lock.read_text()
    case.lock.write_text(original + original[original.index("[[package]]"):])
    with pytest.raises(ValueError, match="locked_source_ambiguous"): assemble(case)
    assert not case.output.exists()


def test_rejects_extra_receipt_fields_instead_of_exporting_unreviewed_metadata(case):
    receipt = json.loads(case.receipts.read_bytes())
    receipt["reports"]["Linux"]["private_note"] = "must not be exported"
    case.receipts.write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="receipt_fields_invalid"): assemble(case)


def test_checked_in_index_preserves_digests_associations_and_source_references():
    root = ROOT / "third_party/python-runtime-notices"
    index = json.loads((root / "index.json").read_bytes())
    receipts_path = ROOT / "third_party/runtime-notice-inputs.json"
    assert index["distribution_approved"] is False
    assert index["receipts_sha256"] == sha256(receipts_path.read_bytes()).hexdigest()
    assert index["lock_lf_sha256"] == sha256((ROOT / "uv.lock").read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    declared = {item["file"] for item in index["license_texts"]}
    # Texts belong to generated evidence/output, not the source checkout.
    assert not (root / "licenses").exists()
    for item in index["license_texts"]:
        assert item["file"] == f'licenses/{notices.checked_digest(item["sha256"])}.txt'
    locked = {(notices.canonicalize_name(item["name"]), item["version"]): item for item in notices.tomllib.loads((ROOT / "uv.lock").read_text())["package"]}
    for package in index["packages"]:
        assert package["source_archive"] == notices.source_reference(locked.get((package["name"], package["version"])))
        for record in package["evidence"]:
            for notice in record["notices"]:
                assert notice["file"] in declared
                assert notice["original_path"].startswith(record["metadata_path"].rsplit("/", 1)[0] + "/")
