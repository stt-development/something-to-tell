"""Archive integrity is not acceptance of the deliberately retained gate failures."""

from hashlib import sha256
import json
from pathlib import Path

import pytest

from services.runtime.scripts.storage_scale_budgets import OPERATIONS, check_report

# This module verifies historical private reports, not runtime behavior.
pytestmark = pytest.mark.internal_documentation

DIRECTORY = Path(__file__).resolve().parents[3] / "docs/verification/baselines"


def _read(name):
    return json.loads((DIRECTORY / name).read_text())


def test_core_review_preserves_original_budgets_and_explicit_size_scope():
    review = _read("p9-009-core-1000-budget-review-v1.json")
    baseline = _read(review["baseline_file"])
    actual = _read(review["actual_file"])
    assert sha256((DIRECTORY / review["baseline_file"]).read_bytes()).hexdigest() == review["baseline_sha256"]
    assert review["compared_node_counts"] == [1000]
    assert review["excluded_node_counts"] == [10000]
    assert review["budget_formula_unchanged"] is True
    scoped = {**baseline, "cases": [case for case in baseline["cases"] if case["node_count"] == 1000]}
    assert check_report(actual, scoped) == review["portable_errors"]
    assert check_report(actual, scoped, compare_observations=True) == review["including_observations_errors"]
    assert review["portable_errors"]  # Never turn this historical failure into a passed gate.


def test_current_complete_workload_does_not_erase_original_save_failure():
    report = _read("p9-009-core-1000-v1.json")
    assert [(case["mode"], case["node_count"]) for case in report["cases"]] == [
        ("local_sqlite", 1000), ("postgresql", 1000),
    ]
    for case in report["cases"]:
        assert case["status"] == "ok" and all(case["integrity"].values())
        assert tuple(row["operation"] for row in case["operations"]) == OPERATIONS
        assert all(row["status"] == "ok" for row in case["operations"])
    before = _read("p9-009-history-1000-v1.json")
    original = next(case for case in before["cases"] if case["mode"] == "postgresql")
    assert original["status"] == "failed"
    assert next(row for row in original["operations"] if row["operation"] == "save")["status"] == "failed"


def test_canon_control_separates_operation_reads_from_background_lease_writes():
    control = _read("p9-009-canon-read-control-v1.json")
    assert control["status"] == "ok" and all(control["integrity"].values())
    assert control["local_cleanup"] == control["database_cleanup"] == "released"
    row = control["operations"][0]
    owned = row["operation_thread"]["sql"]
    assert owned["cursor_calls"] == owned["read_calls"] == 25
    assert owned["write_calls"] == owned["ddl_calls"] == 0
    assert row["cursor_calls"] == 33 and row["write_calls"] == 1
