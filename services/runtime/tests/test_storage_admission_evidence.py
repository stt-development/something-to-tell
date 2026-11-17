"""R2e frozen evidence preserves failed admission and the bounded live recheck."""

import json
from pathlib import Path

import pytest

# Keep archive assertions mandatory internally without publishing their inputs.
pytestmark = pytest.mark.internal_documentation


def test_public_admission_archives_preserve_failures_complete_work_and_owned_cleanup():
    root = Path(__file__).resolve().parents[3] / "docs/verification/baselines"
    before = [json.loads((root / f"p9-009r2e-{transport}-before.json").read_text())
        for transport in ("live", "asgi")]
    after = [json.loads((root / f"p9-009r2e-live-after-{name}.json").read_text())
        for name in ("profile", "control-1", "control-2")]
    assert len({row["fixture_source_sha256"] for row in before + after}) == 1
    assert len({row["environment"]["production_tree"] for row in before}) == 1
    assert len({row["environment"]["production_tree"] for row in after}) == 1
    assert before[0]["environment"]["production_tree"] != after[0]["environment"]["production_tree"]
    assert len({row["probe_sha256"] for row in after}) == 1
    assert len({row["environment"]["baseline_revision"] for row in after}) == 1
    for row in before + after:
        assert row["size"] == "1000" and row["node_count"] == 1000
        assert row["profile_path"] == "public_encrypted"
        assert row["cleanup"] == row["runtime_cleanup"] == row["database_cleanup"] == "released"
        assert row["geometry"] == dict(placements=1116, root_placements=682,
            distinct_root_origins=11, max_roots_at_one_origin=62, variant="pinned_original_overlap")
        assert row["invariants"] and all(row["invariants"].values())
    for row in before:
        assert row["status"] == "failed" and row["error_code"] == "remote_storage_timeout"
        assert row["invariants"] == {"source_authority_preserved": True}
        assert row["sql_failures"] == [{"sqlstate": "25P04", "command": "INSERT"}]
        stages = {item["stage"]: item for item in row["stages"]}
        assert stages["commit"]["failures"] == 1
        assert stages["memory_add"]["calls"] == 80 and stages["memory_add"]["cursor_calls"] == 336
    for row in after:
        assert row["status"] == "ok" and row["transport"] == "live"
        assert "error_code" not in row
        assert row["invariants"] == dict(collections_equal=True, target_authority=True, target_checksum=True)
    profile = after[0]
    assert profile["instrumentation"] == "sql_named_stages"
    assert profile["sql"]["failed_calls"] == 0 and profile["sql_failures"] == []
    stages = {item["stage"]: item for item in profile["stages"]}
    assert stages["memory_batch"]["calls"] == 1 and stages["memory_batch"]["cursor_calls"] == 5
    assert stages["reconcile"]["cursor_calls"] == 106 and stages["commit"]["failures"] == 0
    assert "memory_add" not in stages
    for row in after[1:]:
        assert row["instrumentation"] == "wall_control"
        assert "sql" not in row and "stages" not in row
    for private in ("postgresql+psycopg", "stt_test_password", "/Users/", '"session_id"', '"parameters"'):
        assert private not in json.dumps(before + after)
