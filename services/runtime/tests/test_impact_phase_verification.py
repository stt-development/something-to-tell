"""P5-011 aggregate fixture and checksum lifecycle verification."""

from pathlib import Path
from time import sleep

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.impact import (
    ImpactDependencyTraversal,
    ProjectDependencyProjector,
)
from services.runtime.stt_runtime.project_document.patch import derive_project_patch
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactAnalysisLimits,
    ImpactSeed,
)
from services.runtime.stt_runtime.schemas.canon_check import CanonOwnerRef

FIXTURES = Path(__file__).parents[3] / "fixtures" / "projects"
TERMINAL = {"completed", "failed", "cancelled", "stale"}


def test_file_backed_aurora_matrix_and_citadel_baseline(tmp_path: Path) -> None:
    """One fixture audit proves every Phase 5 adapter and bounded baseline."""

    aurora = import_project_fixture(
        FIXTURES / "project-aurora.v1.json", tmp_path / "AuroraMatrix.narrative"
    ).document
    citadel = import_project_fixture(
        FIXTURES / "citadel-branch.v1.json", tmp_path / "CitadelMatrix.narrative"
    ).document
    aurora_index = ProjectDependencyProjector().project(aurora)
    citadel_index = ProjectDependencyProjector().project(citadel)

    assert {item.domain for item in aurora_index.dependencies} == {
        "graph",
        "composition",
        "flow",
        "dialogue",
        "quest",
        "temporal",
        "playback",
        "canon",
    }
    assert {item.propagation for item in aurora_index.dependencies} == {
        "required",
        "conditional",
        "contextual",
    }
    kinds = {item.kind for item in aurora_index.dependencies}
    assert {
        "flow.invocation-reachability",
        "flow.binding-reachability",
        "dialogue.next-element",
        "quest.branch-reachability",
        "temporal.binding-write",
        "playback.preparation-fact",
        "canon.issue-target",
    } <= kinds
    cycle_ids = {
        item.source.owner_id
        for item in aurora_index.dependencies
        if item.kind == "flow.transition-reachability"
    }
    assert {
        "flow-transition-quest-blockade",
        "flow-transition-blockade-cycle",
    } <= cycle_ids

    traversal = ImpactDependencyTraversal().traverse(
        aurora_index,
        seeds=(ImpactSeed(resource=CanonOwnerRef(owner_type="node", owner_id="node-opening")),),
        direction="both",
        domains=("graph", "composition", "flow", "dialogue", "quest", "temporal", "playback", "canon"),
        limits=ImpactAnalysisLimits(max_depth=10),
    )
    assert {item.domain for item in traversal.findings} == {
        "graph",
        "composition",
        "flow",
        "dialogue",
        "quest",
        "temporal",
        "playback",
        "canon",
    }
    assert any(item.distance == 1 for item in traversal.findings)
    assert any(item.distance > 1 for item in traversal.findings)
    assert all(
        len(path.resources) == len({resource.stable_key() for resource in path.resources})
        for finding in traversal.findings
        for path in finding.paths
    )

    assert not citadel.nodes
    assert not citadel.edges
    assert not citadel_index.resources
    assert not citadel_index.dependencies


def test_edit_save_analyze_patch_undo_redo_close_reopen_preserves_checksums(
    tmp_path: Path,
) -> None:
    """Impact previews stay read-only across the complete local authoring lifecycle."""

    project_path = tmp_path / "ImpactLifecycle.narrative"
    import_project_fixture(FIXTURES / "project-aurora.v1.json", project_path)

    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        ).json()
        session_id = opened["session"]["session_id"]
        project_id = opened["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        original_checksum = opened["document"]["checksum"]

        created = client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": project_id,
                "type": "Event",
                "title": "Impact verification event",
            },
        )
        assert created.status_code == 201, created.json()
        edited = client.get(f"/api/project-sessions/{session_id}").json()
        assert edited["document"]["checksum"] != original_checksum

        saved = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={
                "expected_revision": opened["session"]["saved_revision"],
                "reason": "manual",
            },
        ).json()
        saved_checksum = saved["document"]["checksum"]
        history = client.get(f"/api/project-sessions/{session_id}/history").json()

        selection = _run(
            client,
            session_id,
            saved,
            history["history_revision"],
            {
                "type": "selection",
                "intent": "modify",
                "seeds": [
                    {"resource": {"owner_type": "node", "owner_id": "node-opening"}}
                ],
            },
        )
        document = client.app.state.project_sessions.inspect(session_id).document
        patch = derive_project_patch(document, document).model_dump(mode="json")
        patch_run = _run(
            client,
            session_id,
            saved,
            history["history_revision"],
            {"type": "patch", "patch": patch},
        )

        assert selection["status"] == patch_run["status"] == "completed"
        assert patch_run["findings"] == []
        assert client.get(f"/api/project-sessions/{session_id}").json()["document"][
            "checksum"
        ] == saved_checksum

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": history["history_revision"]},
        ).json()
        assert undone["project"]["document"]["checksum"] != saved_checksum
        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={
                "expected_history_revision": undone["history"]["history_revision"]
            },
        ).json()
        assert redone["project"]["document"]["checksum"] == saved_checksum
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

    with TestClient(create_app()) as restarted:
        reopened = restarted.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        ).json()
        assert reopened["document"]["checksum"] == saved_checksum


def _run(
    client: TestClient,
    session_id: str,
    project: dict,
    history_revision: int,
    scenario: dict,
) -> dict:
    """Run one snapshot-bound scenario and return its terminal projection."""

    response = client.post(
        f"/api/project-sessions/{session_id}/impact-analysis/runs",
        json={
            "observed_saved_revision": project["session"]["saved_revision"],
            "expected_history_revision": history_revision,
            "source_checksum": project["document"]["checksum"],
            "scenario": scenario,
            "direction": "both",
        },
    )
    assert response.status_code == 201, response.json()
    run = response.json()["run"]
    for _ in range(300):
        if run["status"] in TERMINAL:
            return run
        sleep(0.01)
        run = client.get(
            f"/api/project-sessions/{session_id}/impact-analysis/runs/{run['id']}"
        ).json()["run"]
    raise AssertionError(f"impact run did not finish: {run['id']}")
