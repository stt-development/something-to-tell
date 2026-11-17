"""Focused tests for development-only scale fixtures and actual authoring probes."""

import json
from copy import deepcopy
from pathlib import Path
import signal
import time
import tracemalloc

import pytest
from sqlalchemy import create_engine, text

from services.runtime.scripts import benchmark_storage
from services.runtime.scripts.benchmark_storage import environment, run_case
from services.runtime.scripts.scale_fixture import document_for, generate_scale_fixture
from services.runtime.scripts import scale_fixture_files
from services.runtime.scripts.storage_scale_metrics import OperationMetrics
from services.runtime.scripts import storage_scale_metrics as metrics_module
from services.runtime.scripts.storage_scale_budgets import OPERATIONS, check_report, operation_budgets
from services.runtime.stt_runtime.project_fixture import load_project_fixture, write_project_fixture
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry


@pytest.mark.parametrize("size", [1000, 10000])
def test_representative_fixture_is_exact_valid_and_within_existing_limits(size):
    fixture = scale_fixture_files.load_scale_fixture(size)
    document = document_for(fixture)
    assert len(document.nodes) == size
    clusters = size // 16
    assert len(document.dialogues) == len(document.quests) == clusters
    assert len(document.story_flows) == clusters * 3
    assert len(document.narrative_effects) == clusters * 4
    assert len(document.issues) == clusters * 3
    assert len(document.agent_memories) == ((clusters + 7) // 8) * 10 <= 1000
    assert len(document.engine_tag_definitions) == ((clusters + 7) // 8) * 9 <= 2000
    assert any(placement.container_node_id for placement in document.placements)
    assert all(node.project_id == document.manifest.project_id for node in document.nodes)
    assert document.checksum == document_for(fixture).checksum


def test_fixture_bytes_ids_conditions_and_json_references_are_deterministic(tmp_path):
    first, second = generate_scale_fixture(32), generate_scale_fixture(32)
    assert first == second
    path = tmp_path / "fixture.json"
    write_project_fixture(path, first)
    assert load_project_fixture(path) == first
    conditions = [transition.condition for transition in first.flow_transitions if transition.condition]
    assert any("s0000-node-" in condition for condition in conditions)
    assert any("s0001-node-" in condition for condition in conditions)
    assert first.dialogues[0].document.participants[0].startswith("s0000-")
    assert first.dialogues[1].document.participants[0].startswith("s0001-")
    assert all(definition.normalized_key.startswith("scale0000.") for definition in first.engine_tag_definitions)


@pytest.mark.parametrize("size", [0, 15, 10001, True, 16.0])
def test_fixture_rejects_unsupported_sizes(size):
    with pytest.raises(ValueError, match="scale_node_count_out_of_range"):
        generate_scale_fixture(size)


def test_metrics_count_batches_and_remove_listeners_even_on_failure():
    engine = create_engine("sqlite:///:memory:")
    def operation():
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE probe (id integer)"))
            connection.execute(text("INSERT INTO probe VALUES (:id)"), [{"id": 1}, {"id": 2}])
            return connection.execute(text("SELECT count(*) FROM probe")).scalar_one()
    try:
        collector = OperationMetrics()
        result, metrics = collector.measure("probe", operation)
        assert result == 2
        assert metrics["cursor_calls"] == 3
        assert metrics["parameter_sets"] == 4
        assert (metrics["ddl_calls"], metrics["write_calls"], metrics["read_calls"]) == (1, 1, 1)
        assert metrics["python_allocation_peak_bytes"] >= metrics["python_retained_bytes"] >= 0
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        assert collector.calls == 3
        broken = OperationMetrics()
        with pytest.raises(RuntimeError, match="expected"):
            broken.measure("failed", lambda: (_ for _ in ()).throw(RuntimeError("expected")))
        assert broken.last["operation"] == "failed"
        assert not tracemalloc.is_tracing()
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        assert broken.calls == 0
    finally:
        engine.dispose()


def test_small_actual_session_probe_records_integrity_and_redacted_metrics(tmp_path):
    report = run_case(16, "local_sqlite", tmp_path / "case")
    assert report["status"] == "ok"
    assert [item["operation"] for item in report["operations"]] == [
        "open", "narrow_command", "dialogue_aggregate", "undo", "redo", "save", "reopen",
        "analysis_capture", "export_whole_project", "export_story_flows",
    ]
    assert report["integrity"]["export_read_only"] is True
    assert all(item["cursor_calls"] > 0 for item in report["operations"])
    encoded = json.dumps(report)
    assert str(tmp_path) not in encoded
    assert "password" not in encoded
    assert "database_url" not in encoded
    assert not list(tmp_path.rglob("project.lock.json"))
    assert "baseline_revision" in environment()
    baseline = {"report_version": 1, "cases": [report]}
    assert check_report(baseline, baseline, compare_observations=True) == []
    changed = deepcopy(baseline)
    changed["cases"][0]["operations"][1]["cursor_calls"] *= 10
    assert any("cursor_budget" in error for error in check_report(changed, baseline))


def test_disposable_authority_drops_only_its_generated_database_on_failure(monkeypatch):
    statements = []
    class Admin:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def execute(self, statement):
            statements.append(statement.as_string())
    monkeypatch.setenv("STT_TEST_POSTGRES_URL", "postgresql+psycopg://test:secret@localhost/original?sslmode=disable")
    monkeypatch.setattr(benchmark_storage, "_connection", lambda url: Admin())
    with pytest.raises(RuntimeError, match="expected"):
        with benchmark_storage.disposable_database() as url:
            assert url.database.startswith("stt_p9_scale_")
            assert url.database != "original"
            database = url.database
            raise RuntimeError("expected")
    assert statements == [f'CREATE DATABASE "{database}"', f'DROP DATABASE "{database}" WITH (FORCE)']
    assert all("original" not in statement for statement in statements)


def test_postgresql_probe_needs_explicit_test_authority(monkeypatch):
    monkeypatch.delenv("STT_TEST_POSTGRES_URL", raising=False)
    with pytest.raises(ValueError, match="scale_postgresql_test_url_required"):
        with benchmark_storage.disposable_database():
            pytest.fail("Missing authority must not open a project")


def test_analysis_guard_limits_and_restores_timer_and_metrics(monkeypatch):
    monkeypatch.setattr(metrics_module, "ANALYSIS_MAX_SECONDS", 0)
    previous = signal.getsignal(signal.SIGALRM)
    collector = OperationMetrics()
    with pytest.raises(metrics_module.OperationBudgetExceeded, match="wall_time"):
        collector.measure("analysis_capture", lambda: time.sleep(0.5), bounded_analysis=True)
    assert collector.last["wall_seconds"] > 0
    assert not tracemalloc.is_tracing()
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
    assert signal.getsignal(signal.SIGALRM) == previous
    monkeypatch.setattr(metrics_module.tracemalloc, "get_traced_memory", lambda: (11, 12))
    with pytest.raises(metrics_module.OperationBudgetExceeded, match="python_allocation"):
        metrics_module._check_budget(time.perf_counter(), 100, 10)


def _reference_report():
    """Small independent observation model for deterministic budget checker tests."""
    return {"report_version": 1, "cases": [{
        "mode": "local_sqlite", "node_count": 1000, "fixture_version": 1,
        "fixture_checksum": "a" * 64, "fixture_source_sha256": "b" * 64,
        "collection_counts": {"nodes": 1000}, "analysis_guard": {"wall_seconds": 180},
        "integrity": {"export_read_only": True}, "status": "ok",
        "operations": [{"operation": name, "cursor_calls": 30, "wall_seconds": 1.25,
            "python_allocation_peak_bytes": 100, "write_calls": 0, "ddl_calls": 0, "status": "ok"}
            for name in OPERATIONS],
    }]}


def test_budget_formulas_and_optional_hardware_observations():
    baseline = _reference_report()
    assert operation_budgets(baseline["cases"][0]["operations"][0]) == {
        "cursor_calls": 42, "wall_seconds": 3, "python_allocation_peak_bytes": 150,
    }
    changed = deepcopy(baseline)
    changed["cases"][0]["operations"][0]["wall_seconds"] = 4
    assert check_report(changed, baseline) == []
    assert any("wall_seconds_budget" in error for error in check_report(changed, baseline, compare_observations=True))
    changed["report_version"] = 2
    assert "report_version_unsupported" in check_report(changed, baseline)


@pytest.mark.parametrize("change,code", [
    ("missing_case", "case_matrix_mismatch"), ("duplicate_case", "duplicate_case"),
    ("missing_operation", "operation_matrix_mismatch"), ("failed", "failed_case"),
    ("modified_fixture", "fixture_checksum_mismatch"), ("write_export", "mutated_storage"),
    ("guard", "analysis_guard_mismatch"),
])
def test_budget_checker_rejects_incomplete_or_changed_evidence(change, code):
    baseline, changed = _reference_report(), _reference_report()
    case = changed["cases"][0]
    if change == "missing_case":
        changed["cases"] = []
    elif change == "duplicate_case":
        changed["cases"].append(deepcopy(case))
    elif change == "missing_operation":
        case["operations"].pop()
    elif change == "failed":
        case["status"] = "failed"
    elif change == "modified_fixture":
        case["fixture_checksum"] = "changed"
    elif change == "write_export":
        case["operations"][-1]["write_calls"] = 1
    else:
        case["analysis_guard"] = {}
    assert any(code in error for error in check_report(changed, baseline))


def test_censored_capture_is_not_compared_as_successful_latency():
    baseline = _reference_report()
    capture = next(item for item in baseline["cases"][0]["operations"] if item["operation"] == "analysis_capture")
    capture["status"] = "budget_exceeded"
    baseline["cases"][0]["status"] = "limited"
    assert check_report(baseline, baseline, compare_observations=True) == []
    fixed = deepcopy(baseline)
    fixed["cases"][0]["status"] = "ok"
    next(item for item in fixed["cases"][0]["operations"] if item["operation"] == "analysis_capture")["status"] = "ok"
    assert check_report(fixed, baseline) == []


def test_author_deferred_large_history_has_no_fabricated_metrics(tmp_path):
    # Exercise policy on a tiny local session, not a claim of PostgreSQL coverage.
    source = tmp_path / "source.json"
    write_project_fixture(source, generate_scale_fixture(16))
    project = tmp_path / "Deferred.narrative"
    import_project_fixture(source, project)
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    registry = ProjectSessionRegistry()
    report = {"mode": "postgresql", "node_count": 10000, "operations": []}
    try:
        benchmark_storage.measure_operations(registry, project, artifacts, report)
    finally:
        registry.close_all()
    deferred = [item for item in report["operations"] if item["status"] == "deferred"]
    assert [item["operation"] for item in deferred] == ["undo", "redo"]
    assert all("wall_seconds" not in item and "cursor_calls" not in item for item in deferred)
    assert report["integrity"]["redo_matches_changed_document"] is None
    baseline = _reference_report()
    baseline["cases"][0].update(mode="postgresql", node_count=10000, status="limited")
    for index, name in enumerate(OPERATIONS):
        if name in {"undo", "redo"}:
            baseline["cases"][0]["operations"][index] = {"operation": name, "status": "deferred",
                "reason": "author_deferred_until_p9_009"}
    assert check_report(baseline, baseline) == []
    changed = deepcopy(baseline)
    changed["cases"][0]["operations"][3]["reason"] = "unreviewed"
    assert any("invalid_deferral" in error for error in check_report(changed, baseline))


def test_cli_forwards_explicit_full_history_to_isolated_worker(tmp_path, monkeypatch):
    output = tmp_path / "report.json"
    commands = []
    def fake_worker(command, **kwargs):
        commands.append(command)
        assert kwargs["check"] is True
        Path(command[command.index("--report") + 1]).write_text(json.dumps({"status": "mock_worker"}))
    monkeypatch.setattr(benchmark_storage.subprocess, "run", fake_worker)
    monkeypatch.setattr(benchmark_storage.sys, "argv", ["benchmark_storage", "--sizes", "16",
        "--modes", "local_sqlite", "--full-history", "--report", str(output)])
    benchmark_storage.main()
    assert len(commands) == 1
    assert "--worker" in commands[0] and "--full-history" in commands[0]
    assert json.loads(output.read_text()) == {"report_version": 1, "cases": [{"status": "mock_worker"}]}


@pytest.mark.parametrize("size", [1000, 10000])
def test_default_workloads_read_pinned_projects_without_regeneration(size, monkeypatch):
    def unexpected(*args):
        pytest.fail("Normal workload loading must not regenerate the fixture")
    monkeypatch.setattr(scale_fixture_files, "generate_scale_fixture", unexpected)
    monkeypatch.setattr(benchmark_storage, "generate_scale_fixture", unexpected)
    assert len(benchmark_storage.workload_fixture(size).nodes) == size


def test_generator_keeps_multiple_sparse_registry_clusters_valid():
    fixture = generate_scale_fixture(144)
    assert len(fixture.agent_memories) == 20
    assert len(fixture.engine_tag_definitions) == 18
    assert len(document_for(fixture).nodes) == 144


def test_pinned_project_rejects_corrupt_bytes_before_parsing(tmp_path, monkeypatch):
    manifest = scale_fixture_files._manifest()
    monkeypatch.setattr(scale_fixture_files, "DIRECTORY", tmp_path)
    (tmp_path / "manifest.v1.json").write_text(json.dumps(manifest))
    (tmp_path / "storage-scale-1000.v1.json.gz").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="scale_fixture_integrity_error"):
        scale_fixture_files.load_scale_fixture(1000)
    with pytest.raises(ValueError, match="scale_frozen_size_unsupported"):
        scale_fixture_files.load_scale_fixture(999)


@pytest.mark.internal_documentation
def test_frozen_observations_match_pinned_inputs_and_explicit_coverage():
    path = Path(__file__).resolve().parents[3] / "docs/verification/baselines/p9-001-storage-scale-v1.json"
    report = json.loads(path.read_text())
    manifest = scale_fixture_files._manifest()
    assert {(case["mode"], case["node_count"]) for case in report["cases"]} == {
        (mode, size) for mode in ("local_sqlite", "postgresql") for size in (1000, 10000)}
    statuses = []
    for case in report["cases"]:
        descriptor = manifest["projects"][str(case["node_count"])]
        assert case["fixture_checksum"] == descriptor["document_checksum"]
        assert case["fixture_source_sha256"] == manifest["seed_sha256"]
        assert len(case["operations"]) == 10
        statuses.extend(operation["status"] for operation in case["operations"])
    assert statuses.count("ok") == 36
    assert statuses.count("budget_exceeded") == statuses.count("deferred") == 2
    assert check_report(report, report, compare_observations=True) == []
