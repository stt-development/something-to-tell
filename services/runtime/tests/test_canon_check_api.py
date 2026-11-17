"""P4-006 API and concurrency coverage over the complete Project Aurora fixture."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
from threading import Event
from time import sleep

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.canon.coordinator import CanonRunCoordinator
from services.runtime.stt_runtime.canon.engine import CanonRuleEngine
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.canon_check import CanonRunStart

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
CITADEL_FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "citadel-branch.v1.json"


def _open_aurora(client: TestClient, tmp_path: Path, name: str = "Aurora") -> dict:
    project_path = tmp_path / f"{name}.narrative"
    import_project_fixture(FIXTURE, project_path)
    response = client.post("/api/project-sessions/open", json={"path": str(project_path)})
    assert response.status_code == 200
    return response.json()


def _open_single_member_entry_gap(client: TestClient, tmp_path: Path) -> dict:
    """Import one valid draft Flow whose sole member is its only possible entry."""

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    flow = deepcopy(fixture["story_flows"][0])
    flow.update({
        "id": "flow-canon-entry",
        "name": "Canon Entry Example",
        "normalized_name": "canon entry example",
        "description": "Single-member draft used to verify deterministic entry repair.",
        "kind": "standalone",
        "status": "draft",
        "entry_node_id": None,
        "metadata": {"test": "canon-entry-fixer"},
    })
    membership = deepcopy(fixture["story_flow_nodes"][0])
    membership.update({
        "id": "flow-canon-entry:member:node-mara-runs-blockade",
        "flow_id": "flow-canon-entry",
        "node_id": "node-mara-runs-blockade",
        "presentation_order": 0,
        "metadata": {"test": "canon-entry-fixer"},
    })
    fixture["story_flows"].append(flow)
    fixture["story_flow_nodes"].append(membership)
    fixture["story_flows"].sort(key=lambda item: item["id"])
    fixture["story_flow_nodes"].sort(key=lambda item: item["id"])
    fixture["expected_validation"]["story_flow_count"] += 1
    fixture_path = tmp_path / "entry-gap.v1.json"
    fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
    project_path = tmp_path / "EntryGap.narrative"
    import_project_fixture(fixture_path, project_path)
    response = client.post("/api/project-sessions/open", json={"path": str(project_path)})
    assert response.status_code == 200
    return response.json()


def _run_payload(opened: dict, **changes: object) -> dict:
    payload: dict[str, object] = {
        "session_id": opened["session"]["session_id"],
        "observed_saved_revision": opened["session"]["saved_revision"],
        "expected_history_revision": 0,
        "mode": "deterministic",
    }
    payload.update(changes)
    return payload


def _poll_impact(client: TestClient, session_id: str, run_id: str) -> dict:
    """Wait for the ordinary process-local Impact lifecycle used by the bridge."""

    for _ in range(300):
        response = client.get(
            f"/api/project-sessions/{session_id}/impact-analysis/runs/{run_id}"
        )
        assert response.status_code == 200
        run = response.json()["run"]
        if run["status"] in {"completed", "failed", "cancelled", "stale"}:
            return run
        sleep(0.01)
    raise AssertionError(f"impact run did not finish: {run_id}")


def test_canon_run_routes_reconcile_list_review_and_suggest(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        started = client.post("/api/canon-checks/runs", json=_run_payload(opened))

        assert started.status_code == 201
        run = started.json()
        assert run["status"] == "completed"
        assert run["summary"]["fact_count"] > 0
        assert run["summary"]["candidate_count"] == 6
        assert run["summary"]["opened_count"] == 6
        assert run["diagnostics"] == []
        assert client.get(f"/api/canon-checks/runs/{run['id']}").json() == run

        project_id = opened["session"]["project_id"]
        listed = client.get(f"/api/canon-checks/projects/{project_id}/issues")
        assert listed.status_code == 200
        issues = listed.json()
        assert issues["active_count"] == 6
        assert sum(issues["severity"].values()) == 6
        assert all(item["repair"]["source_checksum"] for item in issues["issues"])

        issue_id = next(
            item["id"]
            for item in issues["issues"]
            if item["metadata"]["rule_id"] == "condition.unresolved-path"
        )
        reviewed = client.post(
            f"/api/canon-checks/issues/{issue_id}/status",
            json={
                "session_id": opened["session"]["session_id"],
                "expected_history_revision": 1,
                "status": "review",
            },
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["status"] == "review"
        history = client.get(
            f"/api/project-sessions/{opened['session']['session_id']}/history"
        ).json()
        assert history["next_undo"]["label_key"] == "history.command.updateCanonIssueStatus"

        proposal_source = client.get(
            f"/api/project-sessions/{opened['session']['session_id']}"
        ).json()["document"]["checksum"]
        stale_capability = client.post(
            f"/api/canon-checks/issues/{issue_id}/suggest",
            json={
                "session_id": opened["session"]["session_id"],
                "source_checksum": "0" * 64,
            },
        )
        assert stale_capability.status_code == 409
        assert stale_capability.json()["detail"]["code"] == "canon_repair_capability_stale"
        suggestion = client.post(
            f"/api/canon-checks/issues/{issue_id}/suggest",
            json={
                "session_id": opened["session"]["session_id"],
                "source_checksum": proposal_source,
            },
        )
        assert suggestion.status_code == 200
        proposal = suggestion.json()
        assert proposal["issue_id"] == issue_id
        assert proposal["status"] == "created"
        assert proposal["suggestion_id"] == proposal["suggestion"]["id"]
        assert proposal["suggestion"]["patch"]["source_checksum"] == proposal_source
        assert proposal["suggestion"]["patch"]["operations"]

        approved = client.post(
            f"/api/canon-checks/suggestions/{proposal['suggestion_id']}/approve",
            json={
                "session_id": opened["session"]["session_id"],
                "expected_history_revision": 2,
            },
        )
        assert approved.status_code == 200
        decision = approved.json()
        assert decision["suggestion"]["status"] == "approved"
        assert decision["history"]["next_undo"]["label_key"] == "history.command.approveCanonFix"
        assert any(
            item["id"] == proposal["suggestion_id"] and item["status"] == "approved"
            for item in decision["project"]["document"]["suggestions"]
        )
        # Approval closes the reviewed issue immediately; a later deterministic
        # run reopens it if the candidate still exists.
        remaining = client.get(f"/api/canon-checks/projects/{project_id}/issues").json()
        resolved = next(item for item in remaining["issues"] if item["id"] == issue_id)
        assert resolved["status"] == "resolved"
        assert resolved["metadata"]["resolution_reason"] == "suggestion_approved"

        undone = client.post(
            f"/api/project-sessions/{opened['session']['session_id']}/history/undo",
            json={"expected_history_revision": 3},
        )
        assert undone.status_code == 200
        assert all(
            item["id"] != proposal["suggestion_id"]
            for item in undone.json()["project"]["document"]["suggestions"]
        )


def test_empty_citadel_remains_a_clean_canon_baseline(tmp_path: Path) -> None:
    """The empty production fixture must not manufacture Canon findings or saves."""

    project_path = tmp_path / "Citadel.narrative"
    import_project_fixture(CITADEL_FIXTURE, project_path)
    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        ).json()
        run = client.post(
            "/api/canon-checks/runs",
            json=_run_payload(opened),
        ).json()
        listed = client.get(
            f"/api/canon-checks/projects/{opened['session']['project_id']}/issues"
        ).json()
        inspected = client.get(
            f"/api/project-sessions/{opened['session']['session_id']}"
        ).json()

        assert run["status"] == "completed"
        assert run["summary"]["candidate_count"] == 0
        assert listed["active_count"] == 0
        assert listed["issues"] == []
        assert inspected["session"]["saved_revision"] == opened["session"]["saved_revision"]
        assert inspected["session"]["save_status"] == "clean"


def test_single_member_entry_fix_uses_preview_history_and_reconciliation(
    tmp_path: Path,
) -> None:
    """The new structural fixer stays inside the shared reviewed patch lifecycle."""

    with TestClient(create_app()) as client:
        opened = _open_single_member_entry_gap(client, tmp_path)
        session_id = opened["session"]["session_id"]
        project_id = opened["session"]["project_id"]
        run = client.post("/api/canon-checks/runs", json=_run_payload(opened))
        assert run.status_code == 201
        issue = next(
            item
            for item in client.get(
                f"/api/canon-checks/projects/{project_id}/issues"
            ).json()["issues"]
            if item["metadata"].get("diagnostic", {}).get("fact_code")
            == "flow.missing_entry"
            and item["metadata"]["scope"]["owner_id"] == "flow-canon-entry"
        )
        assert issue["repair"]["kind"] == "deterministic_patch"
        assert issue["repair"]["action"] == "request_fix"
        assert issue["repair"]["available"] is True
        active_checksum = client.get(
            f"/api/project-sessions/{session_id}"
        ).json()["document"]["checksum"]
        assert issue["repair"]["source_checksum"] == active_checksum

        suggested = client.post(
            f"/api/canon-checks/issues/{issue['id']}/suggest",
            json={
                "session_id": session_id,
                "source_checksum": issue["repair"]["source_checksum"],
            },
        )
        assert suggested.status_code == 200
        suggestion = suggested.json()["suggestion"]
        assert suggestion["patch"]["operations"][0]["collection"] == "story_flows"
        assert suggestion["patch"]["operations"][0]["record"]["entry_node_id"] \
            == "node-mara-runs-blockade"

        approved = client.post(
            f"/api/canon-checks/suggestions/{suggestion['id']}/approve",
            json={"session_id": session_id, "expected_history_revision": 1},
        )
        assert approved.status_code == 200
        approved_body = approved.json()
        assert approved_body["history"]["next_undo"]["label_key"] \
            == "history.command.approveCanonFix"

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": approved_body["history"]["history_revision"]},
        )
        assert undone.status_code == 200
        undone_flow = next(
            item for item in undone.json()["project"]["document"]["story_flows"]
            if item["id"] == "flow-canon-entry"
        )
        assert undone_flow["entry_node_id"] is None

        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={"expected_history_revision": undone.json()["history"]["history_revision"]},
        )
        assert redone.status_code == 200
        redone_body = redone.json()
        redone_flow = next(
            item for item in redone_body["project"]["document"]["story_flows"]
            if item["id"] == "flow-canon-entry"
        )
        assert redone_flow["entry_node_id"] == "node-mara-runs-blockade"

        rerun = client.post(
            "/api/canon-checks/runs",
            json=_run_payload(
                redone_body["project"],
                expected_history_revision=redone_body["history"]["history_revision"],
            ),
        )
        assert rerun.status_code == 201
        reconciled = client.get(
            f"/api/canon-checks/projects/{project_id}/issues"
        ).json()["issues"]
        repaired_issue = next(item for item in reconciled if item["id"] == issue["id"])
        assert repaired_issue["status"] == "resolved"


def test_agent_review_issue_seeds_bounded_repeatable_impact_runs(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path, "CanonImpact")
        session_id = opened["session"]["session_id"]
        client.post("/api/canon-checks/runs", json=_run_payload(opened))
        project_id = opened["session"]["project_id"]
        issues = client.get(
            f"/api/canon-checks/projects/{project_id}/issues"
        ).json()["issues"]
        issue = next(
            item
            for item in issues
            if item["repair"]["action"] == "explore_solutions"
            and any(
                target["owner_id"] == "line-ilya-concedes"
                for target in item["metadata"]["targets"]
            )
        )
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        before_impact = client.get(f"/api/project-sessions/{session_id}").json()
        command = {
            "session_id": session_id,
            "expected_history_revision": history["history_revision"],
            "source_checksum": issue["repair"]["source_checksum"],
        }
        expected_resources = {
            (
                owner["owner_type"],
                owner["owner_id"],
                owner.get("context_type"),
                owner.get("context_id"),
            )
            for owner in [
                *issue["metadata"]["targets"],
                *(evidence["owner"] for evidence in issue["metadata"]["evidence"]),
            ]
        }

        first = client.post(
            f"/api/canon-checks/issues/{issue['id']}/impact-analysis",
            json=command,
        )
        repeated = client.post(
            f"/api/canon-checks/issues/{issue['id']}/impact-analysis",
            json=command,
        )

        assert first.status_code == repeated.status_code == 201
        first_run = first.json()["run"]
        repeated_run = repeated.json()["run"]
        assert first_run["id"] != repeated_run["id"]
        assert first_run["request"]["direction"] == "both"
        assert first_run["request"]["scenario"]["intent"] == "modify"
        assert {
            (
                seed["resource"]["owner_type"],
                seed["resource"]["owner_id"],
                seed["resource"].get("context_type"),
                seed["resource"].get("context_id"),
            )
            for seed in first_run["request"]["scenario"]["seeds"]
        } == expected_resources
        completed = _poll_impact(client, session_id, first_run["id"])
        assert completed["status"] == "completed"
        assert any(
            finding["target"]["owner_type"] == "issue"
            and finding["target"]["owner_id"] == issue["id"]
            for finding in completed["findings"]
        )
        # The browser's bounded default includes all direct Aurora consequences
        # without allowing repeated seed paths to consume the whole context.
        selected_findings = completed["findings"][:20]
        direct_finding_ids = {
            finding["id"] for finding in completed["findings"]
            if finding["distance"] == 1
        }
        assert len(direct_finding_ids) == 15
        assert direct_finding_ids.issubset({finding["id"] for finding in selected_findings})
        context = client.post(
            f"/api/project-sessions/{session_id}/impact-analysis/runs/{first_run['id']}/resolution-context",
            json={
                "impact_run_id": first_run["id"],
                "finding_ids": [finding["id"] for finding in selected_findings],
                "source_checksum": first_run["source_checksum"],
                "provider_source": "project_default",
                "model_id": "structured-model",
                "content_consent": True,
            },
        )
        assert context.status_code == 200
        assert len(context.json()["findings"]) == 20
        assert len(json.dumps(context.json(), separators=(",", ":"))) <= 120_000
        unchanged = client.get(f"/api/project-sessions/{session_id}").json()
        assert unchanged["document"]["checksum"] == before_impact["document"]["checksum"]
        assert unchanged["session"]["save_status"] == before_impact["session"]["save_status"]

        stale = client.post(
            f"/api/canon-checks/issues/{issue['id']}/impact-analysis",
            json={**command, "source_checksum": "f" * 64},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "canon_repair_capability_stale"


def test_canon_suggestion_rejects_stale_patch_and_supports_no_proposal(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path, "SuggestionStale")
        client.post("/api/canon-checks/runs", json=_run_payload(opened))
        project_id = opened["session"]["project_id"]
        issues = client.get(f"/api/canon-checks/projects/{project_id}/issues").json()["issues"]
        fixable = next(item for item in issues if item["metadata"]["rule_id"] == "condition.unresolved-path")
        unavailable = next(
            item
            for item in issues
            if item["metadata"]["rule_id"] not in {
                "condition.unresolved-path",
                "outcome.required-reachability",
            }
        )

        no_proposal = client.post(
            f"/api/canon-checks/issues/{unavailable['id']}/suggest",
            json={
                "session_id": opened["session"]["session_id"],
                "source_checksum": unavailable["repair"]["source_checksum"],
            },
        )
        assert no_proposal.json() == {
            "issue_id": unavailable["id"],
            "status": "unavailable",
            "suggestion_id": None,
            "message_key": "canon.repair.unavailable.action_mismatch",
            "suggestion": None,
        }

        proposal = client.post(
            f"/api/canon-checks/issues/{fixable['id']}/suggest",
            json={
                "session_id": opened["session"]["session_id"],
                "source_checksum": fixable["repair"]["source_checksum"],
            },
        ).json()["suggestion"]
        reviewed = client.post(
            f"/api/canon-checks/issues/{fixable['id']}/status",
            json={
                "session_id": opened["session"]["session_id"],
                "expected_history_revision": 1,
                "status": "review",
            },
        )
        assert reviewed.status_code == 200
        stale = client.post(
            f"/api/canon-checks/suggestions/{proposal['id']}/approve",
            json={
                "session_id": opened["session"]["session_id"],
                "expected_history_revision": 2,
            },
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "canon_suggestion_stale"


def test_canon_suggestion_can_be_approved_after_checkpoint_save(tmp_path: Path) -> None:
    """Saving metadata may change the checksum but not invalidate reviewed authoring."""

    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path, "SuggestionAfterSave")
        client.post("/api/canon-checks/runs", json=_run_payload(opened))
        project_id = opened["session"]["project_id"]
        issue = next(
            item
            for item in client.get(f"/api/canon-checks/projects/{project_id}/issues").json()["issues"]
            if item["metadata"]["rule_id"] == "condition.unresolved-path"
        )
        suggestion = client.post(
            f"/api/canon-checks/issues/{issue['id']}/suggest",
            json={
                "session_id": opened["session"]["session_id"],
                "source_checksum": issue["repair"]["source_checksum"],
            },
        ).json()["suggestion"]

        saved = client.post(
            f"/api/project-sessions/{opened['session']['session_id']}/save",
            json={"expected_revision": opened["session"]["saved_revision"], "reason": "manual"},
        )
        assert saved.status_code == 200
        assert saved.json()["document"]["checksum"] != suggestion["patch"]["source_checksum"]

        approved = client.post(
            f"/api/canon-checks/suggestions/{suggestion['id']}/approve",
            json={
                "session_id": opened["session"]["session_id"],
                "expected_history_revision": 1,
            },
        )

        assert approved.status_code == 200, approved.json()
        assert approved.json()["suggestion"]["status"] == "approved"


def test_rejected_canon_suggestion_records_only_the_review_decision(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path, "SuggestionRejected")
        client.post("/api/canon-checks/runs", json=_run_payload(opened))
        project_id = opened["session"]["project_id"]
        issue = next(
            item
            for item in client.get(f"/api/canon-checks/projects/{project_id}/issues").json()["issues"]
            if item["metadata"]["rule_id"] == "condition.unresolved-path"
        )
        proposal = client.post(
            f"/api/canon-checks/issues/{issue['id']}/suggest",
            json={
                "session_id": opened["session"]["session_id"],
                "source_checksum": issue["repair"]["source_checksum"],
            },
        ).json()["suggestion"]
        rejected = client.post(
            f"/api/canon-checks/suggestions/{proposal['id']}/reject",
            json={
                "session_id": opened["session"]["session_id"],
                "expected_history_revision": 1,
            },
        )

        assert rejected.status_code == 200
        body = rejected.json()
        assert body["suggestion"]["status"] == "rejected"
        assert body["history"]["next_undo"]["label_key"] == "history.command.rejectCanonFix"
        audit = next(item for item in body["project"]["document"]["suggestions"] if item["id"] == proposal["id"])
        assert audit["status"] == "rejected"
        assert audit["patch"] == proposal["patch"]


def test_canon_run_accepts_dirty_working_state_and_rejects_obsolete_revision(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        stale = client.post(
            "/api/canon-checks/runs",
            json=_run_payload(opened, observed_saved_revision=99),
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "canon_revision_stale"

        session_id = opened["session"]["session_id"]
        project_id = opened["session"]["project_id"]
        created = client.post(
            "/api/nodes",
            headers={"X-Project-Session-Id": session_id},
            json={"project_id": project_id, "type": "Event", "title": "Unsaved"},
        )
        assert created.status_code == 201
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        dirty = client.post(
            "/api/canon-checks/runs",
            json=_run_payload(
                opened,
                expected_history_revision=history["history_revision"],
            ),
        )
        assert dirty.status_code == 201
        assert dirty.json()["status"] == "completed"
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        assert inspected["session"]["saved_revision"] == opened["session"]["saved_revision"]
        assert inspected["session"]["save_status"] == "dirty"
        assert any(node["title"] == "Unsaved" for node in inspected["document"]["nodes"])


def test_configured_provider_failure_preserves_deterministic_results(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        response = client.post(
            "/api/canon-checks/runs",
            json=_run_payload(
                opened,
                mode="configured_agent",
                remote_consent=True,
            ),
        )

        assert response.status_code == 201
        run = response.json()
        assert run["status"] == "completed"
        assert run["diagnostics"][0]["code"] == "canon_provider_disabled"
        assert run["summary"]["candidate_count"] > 0
        inspected = client.get(
            f"/api/project-sessions/{opened['session']['session_id']}"
        ).json()
        assert inspected["session"]["save_status"] == "dirty"
        assert any(
            issue["metadata"].get("issue_version") == 1
            for issue in inspected["document"]["issues"]
        )


def test_configured_provider_requires_consent_for_each_run(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        response = client.post(
            "/api/canon-checks/runs",
            json=_run_payload(opened, mode="configured_agent"),
        )

        assert response.status_code == 201
        run = response.json()
        assert run["status"] == "completed"
        assert run["diagnostics"][0]["code"] == "canon_provider_consent_required"
        assert run["summary"]["candidate_count"] > 0


class _BlockingEngine:
    """Test engine that exposes the coordinator's unlocked evaluation window."""

    def __init__(self, entered: Event, release: Event) -> None:
        self._delegate = CanonRuleEngine()
        self.rule_pack = self._delegate.rule_pack
        self.registry = self._delegate.registry
        self._entered = entered
        self._release = release

    def evaluate(self, check_input, *, settings=None):
        self._entered.set()
        assert self._release.wait(timeout=5)
        return self._delegate.evaluate(check_input, settings=settings)


def test_cancelled_and_stale_runs_never_write_partial_issues(tmp_path: Path) -> None:
    for outcome in ("cancelled", "stale"):
        project_path = tmp_path / f"{outcome}.narrative"
        import_project_fixture(FIXTURE, project_path)
        registry = ProjectSessionRegistry()
        opened = registry.open(project_path)
        entered = Event()
        release = Event()
        run_id = f"run-{outcome}"
        coordinator = CanonRunCoordinator(
            registry,
            engine_factory=lambda: _BlockingEngine(entered, release),
            run_id_factory=lambda: run_id,
        )
        command = CanonRunStart(
            session_id=opened.session.session_id,
            observed_saved_revision=opened.session.saved_revision,
            expected_history_revision=0,
        )
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(coordinator.start, command)
                assert entered.wait(timeout=5)
                if outcome == "cancelled":
                    assert coordinator.cancel(run_id).status == "running"
                else:
                    registry.mark_dirty(opened.session.session_id)
                    registry.save(
                        opened.session.session_id,
                        expected_revision=opened.session.saved_revision,
                        reason="manual",
                    )
                release.set()
                run = future.result(timeout=5)

            assert run.status == outcome
            assert run.diagnostics
            document = registry.inspect(opened.session.session_id).document
            generated = [
                issue
                for issue in document.issues
                if issue.metadata.get("issue_version") == 1
            ]
            assert generated == []
        finally:
            if registry.inspect(opened.session.session_id).session.save_status != "clean":
                registry.discard(opened.session.session_id)
            registry.close(opened.session.session_id)


def test_project_close_and_runtime_restart_clear_run_state(tmp_path: Path) -> None:
    project_path = tmp_path / "Restart.narrative"
    import_project_fixture(FIXTURE, project_path)
    run_id: str
    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        ).json()
        run_id = client.post(
            "/api/canon-checks/runs", json=_run_payload(opened, mode="configured_agent")
        ).json()["id"]
        discarded = client.post(
            f"/api/project-sessions/{opened['session']['session_id']}/discard"
        )
        assert discarded.status_code == 200
        closed = client.post(
            f"/api/project-sessions/{opened['session']['session_id']}/close"
        )
        assert closed.status_code == 200
        assert client.get(f"/api/canon-checks/runs/{run_id}").status_code == 404

    with TestClient(create_app()) as restarted:
        assert restarted.get(f"/api/canon-checks/runs/{run_id}").status_code == 404
