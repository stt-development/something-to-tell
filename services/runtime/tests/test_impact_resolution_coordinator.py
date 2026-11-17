"""Lifecycle coverage for optional, non-persistent Impact explanations."""

import json
from pathlib import Path
from threading import Event
from time import sleep

import pytest
from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfileRegistry
from services.runtime.stt_runtime.impact.coordinator import ImpactRunCoordinator
from services.runtime.stt_runtime.impact.resolution_agent import (
    ImpactResolutionAgentError,
    ImpactResolutionAgentResponse,
)
from services.runtime.stt_runtime.impact.resolution_coordinator import (
    ImpactResolutionCoordinator,
    ImpactResolutionCoordinatorError,
)
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_document.patch import derive_project_patch
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactAnalysisRequest,
    ImpactAnalysisRun,
)
from services.runtime.stt_runtime.schemas.impact_resolution import (
    ImpactResolutionDraftEdit,
    ImpactResolutionExplanation,
    ImpactResolutionRequest,
    ImpactResolutionReviewCommand,
    ImpactResolutionRun,
)
from services.runtime.stt_runtime.schemas.project_document import create_project_document

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
TERMINAL = {"completed", "failed", "cancelled", "stale"}


class _Agent:
    """Controllable provider boundary for success, failure, cancel, and stale races."""

    def __init__(
        self,
        *,
        error_code: str | None = None,
        entered: Event | None = None,
        release: Event | None = None,
        alternatives: list[dict] | None = None,
    ) -> None:
        self.error_code = error_code
        self.entered = entered
        self.release = release
        self.alternatives = alternatives or []
        self.calls: list[dict] = []

    def run(self, profile, model, context, locale):
        self.calls.append({
            "profile_id": profile.profile_id,
            "model": model,
            "context": context,
            "locale": locale,
        })
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            assert self.release.wait(timeout=5)
        if self.error_code is not None:
            raise ImpactResolutionAgentError(self.error_code)
        evidence = next(
            (
                item
                for resource in context.resources
                for item in resource.evidence
            ),
            None,
        )
        return ImpactResolutionAgentResponse(
            explanation=ImpactResolutionExplanation(
                summary="The selected deterministic path affects later authored resources.",
                why_it_matters=["The route can alter reachable story content."],
                assumptions=["The supplied snapshot remains current."],
                limitations=["Only bounded evidence was available."],
                cited_evidence=[] if evidence is None else [evidence],
            ),
            alternatives=self.alternatives,
        )


def test_completed_explanation_preserves_project_history_issues_and_impact_findings(
    tmp_path: Path,
) -> None:
    harness = _harness(tmp_path, _Agent(), locale="ru")
    try:
        before = harness.sessions.inspect(harness.session_id)
        history = harness.sessions.inspect_history(harness.session_id)
        issue_ids = [item.id for item in before.document.issues]
        original_findings = harness.impact_run.findings

        completed = _run_resolution(harness)

        after = harness.sessions.inspect(harness.session_id)
        assert completed.status == "completed"
        assert completed.explanation is not None
        assert completed.alternatives == ()
        assert harness.agent.calls[0]["locale"] == "ru"
        assert harness.agent.calls[0]["context"].source_checksum == before.document.checksum
        assert [
            item.memory_id
            for item in harness.agent.calls[0]["context"].approved_memory.entries
        ] == ["memory-workflow-04-impact-ru"]
        assert harness.impact.inspect(
            harness.session_id, harness.impact_run.id
        ).findings == original_findings
        assert after.document.checksum == before.document.checksum
        assert after.session.save_status == "clean"
        assert harness.sessions.inspect_history(harness.session_id) == history
        assert [item.id for item in after.document.issues] == issue_ids
    finally:
        harness.close()


@pytest.mark.parametrize("code", [
    "impact_resolution_provider_unavailable",
    "impact_resolution_provider_timeout",
    "impact_resolution_model_incompatible",
    "impact_resolution_response_invalid",
])
def test_provider_failures_are_typed_and_preserve_deterministic_results(
    tmp_path: Path,
    code: str,
) -> None:
    harness = _harness(tmp_path, _Agent(error_code=code))
    try:
        before = harness.sessions.inspect(harness.session_id)
        completed = _run_resolution(harness)

        assert completed.status == "failed"
        assert completed.explanation is None
        assert completed.diagnostics[0].code == code
        assert completed.diagnostics[0].message_key == f"impactResolution.error.{code}"
        assert harness.sessions.inspect(harness.session_id).document.checksum == before.document.checksum
        assert harness.impact.inspect(harness.session_id, harness.impact_run.id).status == "completed"
    finally:
        harness.close()


def test_cancel_discards_late_provider_output(tmp_path: Path) -> None:
    entered = Event()
    release = Event()
    harness = _harness(tmp_path, _Agent(entered=entered, release=release))
    try:
        started = harness.resolution.start(harness.session_id, harness.request())
        assert entered.wait(timeout=5)

        harness.resolution.cancel(harness.session_id, started.id)
        release.set()
        completed = _poll_resolution(harness, started.id)

        assert completed.status == "cancelled"
        assert completed.explanation is None
        assert completed.diagnostics[0].code == "impact_resolution_run_cancelled"
        assert harness.impact.inspect(harness.session_id, harness.impact_run.id).status == "completed"
    finally:
        release.set()
        harness.close()


def test_request_cannot_override_project_model_assignment(tmp_path: Path) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        request = harness.request().model_copy(update={"model_id": "other-model"})
        started = harness.resolution.start(harness.session_id, request)
        completed = _poll_resolution(harness, started.id)

        assert completed.status == "failed"
        assert completed.diagnostics[0].code == "impact_resolution_provider_invalid"
        assert agent.calls == []
    finally:
        harness.close()


def test_explanation_only_alternative_is_published_through_run_lifecycle(
    tmp_path: Path,
) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        agent.alternatives = [{
            "id": "manual-review",
            "finding_ids": list(harness.request().finding_ids),
            "title": "Review the branch manually",
            "rationale": "The bounded evidence does not support a safe automatic patch.",
            "tradeoffs": ["No project records change automatically."],
            "expected_outcomes": ["The deterministic findings remain visible."],
            "patch": None,
        }]

        completed = _run_resolution(harness)

        assert completed.status == "completed"
        assert len(completed.alternatives) == 1
        assert completed.alternatives[0].validation.status == "explanation_only"
        assert completed.alternatives[0].patch is None
    finally:
        harness.close()


def test_valid_patch_is_published_with_runtime_comparison(tmp_path: Path) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        request = harness.request()
        context = harness.impact.build_resolution_context(harness.session_id, request)
        document = harness.sessions.inspect(harness.session_id).document
        selected_id = next(
            item.resource.owner_id
            for item in context.resources
            if item.resource.owner_type == "node"
        )
        payload = document.model_dump(mode="python", exclude={"checksum"})
        payload["nodes"] = [
            node.model_copy(update={"body": f"{node.body} Reviewed."})
            if node.id == selected_id
            else node
            for node in document.nodes
        ]
        patch = derive_project_patch(
            document,
            create_project_document(**payload),
        )
        agent.alternatives = [{
            "id": "validated-change",
            "finding_ids": list(request.finding_ids),
            "title": "Clarify the affected beat",
            "rationale": "The selected authored node needs explicit reviewed wording.",
            "tradeoffs": ["The node text changes after approval."],
            "expected_outcomes": ["Dependency structure remains valid."],
            "patch": patch.model_dump(mode="json"),
        }]

        completed = _run_resolution(harness)

        alternative = completed.alternatives[0]
        assert completed.status == "completed"
        assert alternative.validation.status == "valid"
        assert alternative.semantic_fingerprint
        assert alternative.comparison is not None
        assert alternative.comparison.target_checksum == patch.target_checksum
        assert harness.sessions.inspect(harness.session_id).document.checksum == document.checksum
    finally:
        harness.close()


def test_approve_applies_exact_patch_as_one_undoable_command(tmp_path: Path) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        patch = _configure_valid_alternative(harness, agent, suffix=" Approved.")
        before = harness.sessions.inspect(harness.session_id)
        history_before = harness.sessions.inspect_history(harness.session_id)
        completed = _run_resolution(harness)
        alternative = completed.alternatives[0]

        decision, reviewed = harness.resolution.review(
            harness.session_id,
            completed.id,
            _review_command(completed, alternative.id, alternative.semantic_fingerprint, history_before.history_revision),
            approved=True,
        )

        after = harness.sessions.inspect(harness.session_id)
        history_after = harness.sessions.inspect_history(harness.session_id)
        assert decision.decision == "approved"
        assert reviewed.status == "stale"
        assert after.document.checksum == patch.target_checksum
        assert after.session.save_status == "dirty"
        assert history_after.undo_depth == history_before.undo_depth + 1
        assert history_after.next_undo is not None
        assert history_after.next_undo.command_kind == "approve_impact_resolution"
        assert history_after.next_undo.label_key == "history.command.approveImpactResolution"
        assert history_after.redo_depth == 0

        undone = harness.sessions.undo_history(
            harness.session_id,
            expected_history_revision=history_after.history_revision,
        )
        assert undone.project.document.checksum == before.document.checksum
        assert undone.history.undo_depth == history_before.undo_depth
        assert undone.history.redo_depth == 1
        redone = harness.sessions.redo_history(
            harness.session_id,
            expected_history_revision=undone.history.history_revision,
        )
        assert redone.project.document.checksum == patch.target_checksum
        assert redone.history.undo_depth == history_before.undo_depth + 1
        assert redone.history.redo_depth == 0
    finally:
        harness.close()


def test_reject_is_read_only_persists_and_suppresses_same_proposal(tmp_path: Path) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        _configure_valid_alternative(harness, agent, suffix=" Rejected.")
        before = harness.sessions.inspect(harness.session_id)
        history_before = harness.sessions.inspect_history(harness.session_id)
        completed = _run_resolution(harness)
        alternative = completed.alternatives[0]

        decision, reviewed = harness.resolution.review(
            harness.session_id,
            completed.id,
            _review_command(completed, alternative.id, alternative.semantic_fingerprint, history_before.history_revision),
            approved=False,
        )

        after = harness.sessions.inspect(harness.session_id)
        assert decision.decision == "rejected"
        assert reviewed.alternatives == ()
        assert after.document.checksum == before.document.checksum
        assert after.session.save_status == "clean"
        assert harness.sessions.inspect_history(harness.session_id) == history_before
        stored = harness.sessions.list_impact_resolution_decisions(harness.session_id)
        assert stored == (decision,)
        assert set(stored[0].model_dump()) == {
            "decision_version",
            "finding_fingerprints",
            "proposal_semantic_fingerprint",
            "source_checksum",
            "decision",
            "decided_at",
        }

        suppressed = _run_resolution(harness)
        assert suppressed.alternatives == ()
        explicit = harness.resolution.start(
            harness.session_id,
            harness.request().model_copy(update={"include_rejected": True}),
        )
        assert _poll_resolution(harness, explicit.id).alternatives

        repeated = _poll_resolution(harness, explicit.id)
        repeated_alternative = repeated.alternatives[0]
        repeated_decision, _ = harness.resolution.review(
            harness.session_id,
            repeated.id,
            _review_command(
                repeated,
                repeated_alternative.id,
                repeated_alternative.semantic_fingerprint,
                history_before.history_revision,
            ),
            approved=False,
        )
        assert repeated_decision.decision == "rejected"
        assert harness.sessions.list_impact_resolution_decisions(harness.session_id) == (
            repeated_decision,
        )

        project_path = Path(after.session.project_path)
        harness.resolution.clear_all()
        harness.impact.clear_all()
        harness.sessions.close(harness.session_id)
        reopened = harness.sessions.open(project_path)
        harness.session_id = reopened.session.session_id
        assert harness.sessions.list_impact_resolution_decisions(harness.session_id) == (
            repeated_decision,
        )
    finally:
        harness.close()


def test_edit_revalidates_patch_and_creates_new_local_identity(tmp_path: Path) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        _configure_valid_alternative(harness, agent, suffix=" First draft.")
        completed = _run_resolution(harness)
        base = completed.alternatives[0]
        edited_patch = _node_body_patch(harness, suffix=" Edited draft.")

        edited = harness.resolution.edit(
            harness.session_id,
            completed.id,
            ImpactResolutionDraftEdit(alternative_id=base.id, patch=edited_patch),
        )

        alternative = edited.alternatives[0]
        assert alternative.id.startswith("local-edit-")
        assert alternative.id != base.id
        assert alternative.semantic_fingerprint != base.semantic_fingerprint
        assert alternative.validation.status == "valid"
        assert alternative.patch == edited_patch
        assert edited.visual_projections[0].alternative_fingerprint == alternative.semantic_fingerprint
        assert harness.sessions.inspect(harness.session_id).document.checksum == completed.source_checksum
    finally:
        harness.close()


def test_content_locale_edit_during_provider_run_publishes_stale_without_output(
    tmp_path: Path,
) -> None:
    entered = Event()
    release = Event()
    harness = _harness(tmp_path, _Agent(entered=entered, release=release))
    try:
        started = harness.resolution.start(harness.session_id, harness.request())
        assert entered.wait(timeout=5)
        current = harness.sessions.inspect(harness.session_id)
        harness.sessions.update_settings(
            harness.session_id,
            name=current.document.manifest.name,
            description=current.document.manifest.description,
            settings=current.document.manifest.settings.model_copy(
                update={"content_locale": "ru"}
            ),
            expected_history_revision=harness.sessions.inspect_history(
                harness.session_id
            ).history_revision,
        )

        release.set()
        completed = _poll_resolution(harness, started.id)

        assert completed.status == "stale"
        assert completed.explanation is None
        assert completed.diagnostics[0].code == "impact_resolution_run_stale"
    finally:
        release.set()
        harness.close()


def test_save_rebases_checksum_and_invalidates_resolution_without_changing_history(
    tmp_path: Path,
) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        _configure_valid_alternative(harness, agent, suffix=" Pending save.")
        completed = _run_resolution(harness)
        before = harness.sessions.inspect(harness.session_id)
        history_before = harness.sessions.inspect_history(harness.session_id)

        saved = harness.sessions.save(
            harness.session_id,
            expected_revision=before.session.saved_revision,
            reason="manual",
        )

        assert saved.session.saved_revision == before.session.saved_revision + 1
        assert saved.document.checksum != before.document.checksum
        assert harness.sessions.inspect_history(harness.session_id) == history_before
        stale = harness.resolution.inspect(harness.session_id, completed.id)
        assert stale.status == "stale"
        assert stale.explanation == completed.explanation
        assert stale.alternatives == completed.alternatives
        assert harness.impact.inspect(harness.session_id, harness.impact_run.id).status == "stale"
    finally:
        harness.close()


def test_clean_save_as_invalidates_snapshot_bound_resolution(tmp_path: Path) -> None:
    agent = _Agent()
    harness = _harness(tmp_path, agent)
    try:
        _configure_valid_alternative(harness, agent, suffix=" Portable copy.")
        completed = _run_resolution(harness)
        current = harness.sessions.inspect(harness.session_id)

        copied = harness.sessions.save_as(
            harness.session_id,
            destination=tmp_path / "Aurora-copy.narrative",
            expected_revision=current.session.saved_revision,
            identity="regenerate",
            replace_existing=False,
        )

        assert copied.project_id != current.session.project_id
        assert harness.sessions.inspect_history(harness.session_id).undo_depth == 0
        assert harness.sessions.inspect_history(harness.session_id).redo_depth == 0
        assert harness.resolution.inspect(harness.session_id, completed.id).status == "stale"
    finally:
        harness.close()


def test_close_and_reopen_remove_process_local_resolution_run(tmp_path: Path) -> None:
    harness = _harness(tmp_path, _Agent())
    try:
        completed = _run_resolution(harness)
        project_path = Path(
            harness.sessions.inspect(harness.session_id).session.project_path
        )

        harness.sessions.close(harness.session_id)
        reopened = harness.sessions.open(project_path)
        harness.session_id = reopened.session.session_id

        with pytest.raises(
            ImpactResolutionCoordinatorError,
            match="impact_resolution_run_not_found",
        ):
            harness.resolution.inspect(harness.session_id, completed.id)
    finally:
        harness.close()


def test_resolution_api_start_poll_is_read_only(tmp_path: Path) -> None:
    settings = RuntimeSettings(
        storage_profiles_file=tmp_path / "storage.json",
        storage_master_key_file=tmp_path / "runtime.key",
        canon_provider_profiles_file=tmp_path / "providers.enc",
    )
    app = create_app(settings)
    agent = _Agent()
    with TestClient(app) as client:
        profile = app.state.canon_provider_profiles.add(
            label="API Provider",
            provider="openai",
            api_key="private-api-provider-key",
        )
        project_path = _configured_aurora(tmp_path, profile.profile_id)
        opened_response = client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        )
        assert opened_response.status_code == 200
        opened = opened_response.json()
        session_id = opened["session"]["session_id"]
        impact_response = client.post(
            f"/api/project-sessions/{session_id}/impact-analysis/runs",
            json={
                "observed_saved_revision": opened["session"]["saved_revision"],
                "expected_history_revision": 0,
                "source_checksum": opened["document"]["checksum"],
                "scenario": {
                    "type": "selection",
                    "intent": "modify",
                    "seeds": [{
                        "resource": {"owner_type": "node", "owner_id": "node-opening"}
                    }],
                },
                "direction": "both",
            },
        )
        assert impact_response.status_code == 201
        impact_run = _poll_api_impact(
            client, session_id, impact_response.json()["run"]["id"]
        )
        history_before = client.get(
            f"/api/project-sessions/{session_id}/history"
        ).json()
        app.state.impact_resolution_runs.clear_all()
        app.state.impact_resolution_runs = ImpactResolutionCoordinator(
            app.state.project_sessions,
            app.state.impact_runs,
            app.state.canon_provider_profiles,
            agent=agent,
        )
        request = {
            "impact_run_id": impact_run["id"],
            "finding_ids": [item["id"] for item in impact_run["findings"][:3]],
            "source_checksum": opened["document"]["checksum"],
            "provider_source": "project_default",
            "model_id": "structured-model",
            "content_consent": True,
        }
        source_document = create_project_document(**{
            key: value for key, value in opened["document"].items() if key != "checksum"
        })
        candidate_payload = source_document.model_dump(mode="python", exclude={"checksum"})
        candidate_payload["nodes"] = [
            node.model_copy(update={"body": f"{node.body} API reviewed."})
            if node.id == "node-opening"
            else node
            for node in source_document.nodes
        ]
        api_patch = derive_project_patch(
            source_document,
            create_project_document(**candidate_payload),
        )
        agent.alternatives = [{
            "id": "api-alternative",
            "finding_ids": request["finding_ids"],
            "title": "Review the opening",
            "rationale": "The opening needs a bounded clarification.",
            "tradeoffs": ["Authored wording changes only after approval."],
            "expected_outcomes": ["The proposal remains structurally valid."],
            "patch": api_patch.model_dump(mode="json"),
        }]

        started = client.post(
            f"/api/project-sessions/{session_id}/impact-analysis/resolution-runs",
            json=request,
        )
        assert started.status_code == 201
        completed = _poll_api_resolution(
            client, session_id, started.json()["run"]["id"]
        )

        assert completed["status"] == "completed"
        assert completed["explanation"]["summary"]
        assert len(completed["alternatives"]) == 1
        rejected = client.post(
            f"/api/project-sessions/{session_id}/impact-analysis/resolution-runs/{completed['id']}/reject",
            json={
                "alternative_id": completed["alternatives"][0]["id"],
                "proposal_semantic_fingerprint": completed["alternatives"][0]["semantic_fingerprint"],
                "source_checksum": completed["source_checksum"],
                "expected_history_revision": history_before["history_revision"],
            },
        )
        assert rejected.status_code == 200
        assert rejected.json()["decision"]["decision"] == "rejected"
        current = client.get(f"/api/project-sessions/{session_id}").json()
        assert current["session"]["save_status"] == "clean"
        assert current["document"]["checksum"] == opened["document"]["checksum"]
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == history_before


class _Harness:
    def __init__(
        self,
        sessions: ProjectSessionRegistry,
        impact: ImpactRunCoordinator,
        resolution: ImpactResolutionCoordinator,
        session_id: str,
        impact_run: ImpactAnalysisRun,
        agent: _Agent,
    ) -> None:
        self.sessions = sessions
        self.impact = impact
        self.resolution = resolution
        self.session_id = session_id
        self.impact_run = impact_run
        self.agent = agent

    def request(self) -> ImpactResolutionRequest:
        return ImpactResolutionRequest(
            impact_run_id=self.impact_run.id,
            finding_ids=[item.id for item in self.impact_run.findings[:3]],
            source_checksum=self.impact_run.source_checksum,
            provider_source="project_default",
            model_id="structured-model",
            content_consent=True,
        )

    def close(self) -> None:
        self.resolution.clear_all()
        self.impact.clear_all()
        self.sessions.close_all()


def _harness(tmp_path: Path, agent: _Agent, *, locale: str = "en") -> _Harness:
    profiles = CanonProviderProfileRegistry(
        tmp_path / "providers.enc",
        tmp_path / "providers.key",
    )
    profile = profiles.add(
        label="Test Provider",
        provider="openai",
        api_key="private-test-provider-key",
    )
    project_path = _configured_aurora(tmp_path, profile.profile_id, locale=locale)

    impact_holder: list[ImpactRunCoordinator] = []
    resolution_holder: list[ImpactResolutionCoordinator] = []

    def invalidate_authoring(project_id: str) -> None:
        """Mirror the runtime's process-state invalidation callback graph."""

        if impact_holder:
            impact_holder[0].invalidate_project(project_id)
        if resolution_holder:
            resolution_holder[0].invalidate_project(project_id)

    def clear_session(session_id: str, project_id: str) -> None:
        """Drop process-local runs when the owning project session closes."""

        if impact_holder:
            impact_holder[0].clear_session(session_id, project_id)
        if resolution_holder:
            resolution_holder[0].clear_session(session_id, project_id)

    sessions = ProjectSessionRegistry(
        on_authoring_committed=invalidate_authoring,
        on_session_closed=clear_session,
    )
    opened = sessions.open(project_path)
    session_id = opened.session.session_id
    impact = ImpactRunCoordinator(sessions)
    impact_holder.append(impact)
    history_revision = sessions.inspect_history(session_id).history_revision
    impact_run = impact.start(
        session_id,
        ImpactAnalysisRequest(
            observed_saved_revision=opened.session.saved_revision,
            expected_history_revision=history_revision,
            source_checksum=opened.document.checksum,
            scenario={
                "type": "selection",
                "intent": "modify",
                "seeds": [{
                    "resource": {"owner_type": "node", "owner_id": "node-opening"}
                }],
            },
            direction="both",
        ),
    )
    impact_run = _poll_impact(impact, session_id, impact_run.id)
    assert impact_run.status == "completed" and impact_run.findings
    resolution = ImpactResolutionCoordinator(
        sessions,
        impact,
        profiles,
        agent=agent,
    )
    resolution_holder.append(resolution)
    return _Harness(sessions, impact, resolution, session_id, impact_run, agent)


def _configured_aurora(
    tmp_path: Path,
    profile_id: str,
    *,
    locale: str = "en",
) -> Path:
    fixture_payload = json.loads(FIXTURE.read_text())
    fixture_payload["manifest"]["settings_version"] = 4
    fixture_payload["manifest"]["settings"].update({
        "content_locale": locale,
        "agent_providers": {
            "agent_providers_version": 1,
            "default_provider_profile_id": profile_id,
            "agents": {
                "canon_checker": {
                    "provider_source": "project_default",
                    "provider_profile_override_id": None,
                    "model_id": None,
                },
                "impact_resolver": {
                    "provider_source": "project_default",
                    "provider_profile_override_id": None,
                    "model_id": "structured-model",
                },
            },
        },
        "impact_resolver": {
            "impact_resolver_version": 1,
            "agent_mode": "configured",
            "content_policy": "bounded_evidence",
        },
    })
    fixture_file = tmp_path / "configured-aurora.json"
    fixture_file.write_text(json.dumps(fixture_payload))
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(fixture_file, project_path)
    return project_path


def _run_resolution(harness: _Harness) -> ImpactResolutionRun:
    started = harness.resolution.start(harness.session_id, harness.request())
    return _poll_resolution(harness, started.id)


def _node_body_patch(harness: _Harness, *, suffix: str):
    """Build one deterministic, valid node edit against the active snapshot."""

    request = harness.request()
    context = harness.impact.build_resolution_context(harness.session_id, request)
    document = harness.sessions.inspect(harness.session_id).document
    selected_id = next(
        item.resource.owner_id
        for item in context.resources
        if item.resource.owner_type == "node"
    )
    payload = document.model_dump(mode="python", exclude={"checksum"})
    payload["nodes"] = [
        node.model_copy(update={"body": f"{node.body}{suffix}"})
        if node.id == selected_id
        else node
        for node in document.nodes
    ]
    return derive_project_patch(document, create_project_document(**payload))


def _configure_valid_alternative(
    harness: _Harness,
    agent: _Agent,
    *,
    suffix: str,
):
    """Configure the fake provider with one reviewable exact patch."""

    patch = _node_body_patch(harness, suffix=suffix)
    agent.alternatives = [{
        "id": "validated-change",
        "finding_ids": list(harness.request().finding_ids),
        "title": "Clarify the affected beat",
        "rationale": "The selected authored node needs explicit reviewed wording.",
        "tradeoffs": ["The node text changes after approval."],
        "expected_outcomes": ["Dependency structure remains valid."],
        "patch": patch.model_dump(mode="json"),
    }]
    return patch


def _review_command(
    run: ImpactResolutionRun,
    alternative_id: str,
    fingerprint: str | None,
    history_revision: int,
) -> ImpactResolutionReviewCommand:
    """Capture the exact browser-observed proposal identity for review."""

    assert fingerprint is not None
    return ImpactResolutionReviewCommand(
        alternative_id=alternative_id,
        proposal_semantic_fingerprint=fingerprint,
        source_checksum=run.source_checksum,
        expected_history_revision=history_revision,
    )


def _poll_impact(
    coordinator: ImpactRunCoordinator,
    session_id: str,
    run_id: str,
) -> ImpactAnalysisRun:
    for _ in range(500):
        run = coordinator.inspect(session_id, run_id)
        if run.status in TERMINAL:
            return run
        sleep(0.01)
    raise AssertionError("Impact Analysis did not finish")


def _poll_resolution(harness: _Harness, run_id: str) -> ImpactResolutionRun:
    for _ in range(500):
        run = harness.resolution.inspect(harness.session_id, run_id)
        if run.status in TERMINAL:
            return run
        sleep(0.01)
    raise AssertionError("Impact Resolution did not finish")


def _poll_api_impact(client: TestClient, session_id: str, run_id: str) -> dict:
    path = f"/api/project-sessions/{session_id}/impact-analysis/runs/{run_id}"
    for _ in range(500):
        response = client.get(path)
        assert response.status_code == 200
        run = response.json()["run"]
        if run["status"] in TERMINAL:
            return run
        sleep(0.01)
    raise AssertionError("Impact Analysis API run did not finish")


def _poll_api_resolution(client: TestClient, session_id: str, run_id: str) -> dict:
    path = f"/api/project-sessions/{session_id}/impact-analysis/resolution-runs/{run_id}"
    for _ in range(500):
        response = client.get(path)
        assert response.status_code == 200
        run = response.json()["run"]
        if run["status"] in TERMINAL:
            return run
        sleep(0.01)
    raise AssertionError("Impact Resolution API run did not finish")
