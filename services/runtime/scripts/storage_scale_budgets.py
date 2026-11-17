"""P9-001 baseline-relative regression checks, separate from production readiness.

Cursor budgets are portable within the recorded dialect/fixture/toolchain.
Wall/allocation checks are opt-in observations and require comparable hardware.
"""

import argparse
import json
import math
from pathlib import Path

OPERATIONS = (
    "open", "narrow_command", "dialogue_aggregate", "undo", "redo", "save", "reopen",
    "analysis_capture", "export_whole_project", "export_story_flows",
)
READ_ONLY = {"analysis_capture", "export_whole_project", "export_story_flows"}


def operation_budgets(observed):
    """Freeze headroom as a formula over checked-in evidence, not arbitrary targets."""
    return {
        "cursor_calls": observed["cursor_calls"] + max(12, math.ceil(observed["cursor_calls"] * 0.1)),
        "wall_seconds": math.ceil(observed["wall_seconds"] * 2),
        "python_allocation_peak_bytes": math.ceil(observed["python_allocation_peak_bytes"] * 1.5),
    }


def check_report(report, baseline, *, compare_observations=False):
    errors = []
    if report.get("report_version") != 1 or baseline.get("report_version") != 1:
        errors.append("report_version_unsupported")
    def indexed(cases):
        result = {}
        for case in cases:
            key = (case["mode"], case["node_count"])
            if key in result:
                errors.append(f"{key}: duplicate_case")
            result[key] = case
        return result
    actual, expected = indexed(report["cases"]), indexed(baseline["cases"])
    if set(actual) != set(expected):
        errors.append("case_matrix_mismatch")
    for key in sorted(set(actual) & set(expected)):
        case, reference = actual[key], expected[key]
        for field in ("fixture_version", "fixture_checksum", "fixture_source_sha256", "collection_counts", "analysis_guard"):
            if case[field] != reference[field]:
                errors.append(f"{key}: {field}_mismatch")
        if case["status"] not in {"ok", "limited"}:
            errors.append(f"{key}: failed_case")
        actual_integrity, expected_integrity = case.get("integrity", {}), reference.get("integrity", {})
        if any(actual_integrity.get(name) != value if value is not None else actual_integrity.get(name) not in (None, True)
               for name, value in expected_integrity.items()):
            errors.append(f"{key}: integrity_mismatch")
        operations = case["operations"]
        if tuple(item["operation"] for item in operations) != OPERATIONS:
            errors.append(f"{key}: operation_matrix_mismatch")
        originals = {item["operation"]: item for item in reference["operations"]}
        for item in operations:
            name = item["operation"]
            if name not in originals:
                continue
            before = originals[name]
            if before["status"] == "deferred":
                allowed = (key[0] == "postgresql" and key[1] > 1000 and name in {"undo", "redo"}
                           and before.get("reason") == "author_deferred_until_p9_009")
                if not allowed or (item["status"] != "ok" and item != before):
                    errors.append(f"{key}/{name}: invalid_deferral")
                continue  # No measurement exists: do not invent a cursor/time budget.
            if item["status"] != "ok":
                # A successful replacement for a previously censored capture is welcome.
                if not (name == "analysis_capture" and item["status"] == before["status"] == "budget_exceeded"):
                    errors.append(f"{key}/{name}: unsuccessful_operation")
            if name in READ_ONLY and (item["write_calls"] or item["ddl_calls"]):
                errors.append(f"{key}/{name}: mutated_storage")
            budget = operation_budgets(before)
            if item["cursor_calls"] > budget["cursor_calls"]:
                errors.append(f"{key}/{name}: cursor_budget")
            if compare_observations and item["status"] == before["status"] == "ok":
                for field in ("wall_seconds", "python_allocation_peak_bytes"):
                    if item[field] > budget[field]:
                        errors.append(f"{key}/{name}: {field}_budget")
            if "artifact" in before:
                for field in ("nodes", "records"):
                    if item.get("artifact", {}).get(field) != before["artifact"][field]:
                        errors.append(f"{key}/{name}: artifact_{field}_mismatch")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--compare-observations", action="store_true")
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    errors = check_report(report, json.loads(args.baseline.read_text()),
                          compare_observations=args.compare_observations)
    for error in errors:
        print(error)
    print(f"Storage baseline regression checks: {len(errors)} errors. Not a production-readiness gate.")
    deferred = sum(item["status"] == "deferred" for case in report["cases"] for item in case["operations"])
    if deferred:
        print(f"{deferred} author-deferred stress operations have no measured regression budget.")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
