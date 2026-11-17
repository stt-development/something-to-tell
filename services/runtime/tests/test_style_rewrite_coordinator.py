"""Observable and non-mutating Style Rewriter lifecycle coverage."""

import json
from pathlib import Path
from threading import Event
from time import sleep

import pytest

from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfileRegistry
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.style_rewrite import (
    StyleRewriteApprovalV1,
    StyleRewriteRequestV1,
    StyleRewriteRetryV1,
)
from services.runtime.stt_runtime.style_system.rewrite_agent import StyleRewriteAgentResponse
from services.runtime.stt_runtime.style_system.rewrite_coordinator import (
    StyleRewriteCoordinator,
    StyleRewriteCoordinatorError,
)

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
TERMINAL = {"completed", "failed", "cancelled", "stale"}


class _Agent:
    """Controllable provider boundary for lifecycle and immutable snapshot tests."""

    def __init__(self, entered: Event | None = None, release: Event | None = None) -> None:
        self.entered = entered
        self.release = release
        self.calls: list[object] = []

    def run(self, profile, model_id, context):
        self.calls.append(context)
        if self.entered:
            self.entered.set()
        if self.release:
            assert self.release.wait(timeout=5)
        return StyleRewriteAgentResponse(
            rewritten_text="Rain veiled the inspection office inside Glass Harbor.",
            explanation="The revision applies concrete maritime imagery.",
            applied_traits=("concrete maritime language",),
            factual_risks=(),
        )


def test_completed_run_preserves_document_and_history_and_retry_links_predecessor(tmp_path: Path) -> None:
    sessions, coordinator, session_id, agent = _harness(tmp_path)
    try:
        before = sessions.inspect(session_id)
        history_before = sessions.inspect_history(session_id)
        first = _poll(coordinator, session_id, coordinator.start(_request(sessions, session_id)).id)
        retried = coordinator.retry(
            session_id,
            first.id,
            StyleRewriteRetryV1(
                observed_source_checksum=before.document.checksum,
                expected_history_revision=history_before.history_revision,
                additional_instructions="Use fewer words.",
                content_consent=True,
            ),
        )
        second = _poll(coordinator, session_id, retried.id)

        assert first.status == second.status == "completed"
        assert second.predecessor_run_id == first.id
        assert first.request.additional_instructions == ""
        assert second.request.additional_instructions == "Use fewer words."
        assert second.recommendation is not None
        assert second.recommendation.provider_disclosure.provider == "openai"
        assert sessions.inspect(session_id).document.checksum == before.document.checksum
        assert sessions.inspect_history(session_id) == history_before
        assert len(agent.calls) == 2
        assert [item.memory_id for item in agent.calls[0].approved_memory.entries] == [
            "memory-style-02-scene-opening-en",
            "memory-style-01-project-en",
        ]
        assert agent.calls[1].approved_memory == agent.calls[0].approved_memory
        # A completed or retried recommendation cannot silently promote its
        # provider prose into the reviewed project memory catalog.
        assert sessions.inspect(session_id).document.agent_memories == (
            before.document.agent_memories
        )
    finally:
        coordinator.clear_all()
        sessions.close_all()


def test_cancel_discards_late_output_and_authoring_invalidation_marks_stale(tmp_path: Path) -> None:
    entered, release = Event(), Event()
    sessions, coordinator, session_id, _ = _harness(tmp_path, _Agent(entered, release))
    try:
        cancelled = coordinator.start(_request(sessions, session_id))
        assert entered.wait(timeout=5)
        coordinator.cancel(session_id, cancelled.id)
        release.set()
        cancelled = _poll(coordinator, session_id, cancelled.id)
        assert cancelled.status == "cancelled"
        assert cancelled.recommendation is None

        completed = coordinator.start(_request(sessions, session_id))
        completed = _poll(coordinator, session_id, completed.id)
        coordinator.invalidate_project(completed.project_id)
        assert coordinator.inspect(session_id, completed.id).status == "stale"
    finally:
        release.set()
        coordinator.clear_all()
        sessions.close_all()


def test_approve_applies_one_history_command_then_stales_the_consumed_run(tmp_path: Path) -> None:
    sessions, coordinator, session_id, _ = _harness(tmp_path)
    try:
        source_checksum = sessions.inspect(session_id).document.checksum
        completed = _poll(
            coordinator,
            session_id,
            coordinator.start(_request(sessions, session_id)).id,
        )
        assert completed.recommendation is not None
        assert completed.recommendation.validation_status == "valid"

        result, consumed = coordinator.approve(
            session_id,
            completed.id,
            StyleRewriteApprovalV1(
                recommendation_id=completed.recommendation.id,
                source_checksum=completed.source_checksum,
                expected_history_revision=completed.history_revision,
            ),
        )

        node = next(
            item for item in result.project.document.nodes
            if item.id == "node-customs-office"
        )
        assert node.summary == node.body == completed.recommendation.rewritten_text
        assert result.history.next_undo is not None
        assert result.history.next_undo.label_key == "history.command.approveStyleRewrite"
        assert consumed.status == "stale"
        with pytest.raises(StyleRewriteCoordinatorError) as reused:
            coordinator.approve(
                session_id,
                completed.id,
                StyleRewriteApprovalV1(
                    recommendation_id=completed.recommendation.id,
                    source_checksum=completed.source_checksum,
                    expected_history_revision=result.history.history_revision,
                ),
            )
        assert reused.value.code == "style_rewrite_patch_invalid"
        target_checksum = result.project.document.checksum
        undone = sessions.undo_history(
            session_id,
            expected_history_revision=result.history.history_revision,
        )
        assert undone.project.document.checksum == source_checksum
        redone = sessions.redo_history(
            session_id,
            expected_history_revision=undone.history.history_revision,
        )
        assert redone.project.document.checksum == target_checksum
    finally:
        coordinator.clear_all()
        sessions.close_all()


def test_unapproved_provider_output_is_process_local_across_close_and_reopen(
    tmp_path: Path,
) -> None:
    """Closing a rejected preview must persist neither response prose nor run state."""

    sessions, coordinator, session_id, _ = _harness(tmp_path)
    try:
        before = sessions.inspect(session_id)
        project_path = Path(before.session.project_path)
        completed = _poll(
            coordinator,
            session_id,
            coordinator.start(_request(sessions, session_id)).id,
        )
        assert completed.recommendation is not None
        provider_text = completed.recommendation.rewritten_text.encode()
        provider_explanation = completed.recommendation.explanation.encode()
        coordinator.clear_all()
        sessions.close(session_id)

        persisted = b"".join(
            path.read_bytes()
            for path in project_path.rglob("*")
            if path.is_file()
        )
        reopened = sessions.open(project_path)
        assert reopened.document.checksum == before.document.checksum
        assert provider_text not in persisted
        assert provider_explanation not in persisted
        with pytest.raises(StyleRewriteCoordinatorError) as missing:
            coordinator.inspect(reopened.session.session_id, completed.id)
        assert missing.value.code == "style_rewrite_run_not_found"
    finally:
        coordinator.clear_all()
        sessions.close_all()


def _harness(tmp_path: Path, agent: _Agent | None = None):
    """Create a configured Aurora session with machine-local credentials."""

    profiles = CanonProviderProfileRegistry(tmp_path / "providers.enc", tmp_path / "key")
    profile = profiles.add(
        label="Style Provider", provider="openai", api_key="private-test-provider-key"
    )
    payload = json.loads(FIXTURE.read_text())
    payload["manifest"]["settings_version"] = 5
    settings = payload["manifest"]["settings"]
    settings["style_system"].update({
        "agent_mode": "configured", "content_policy": "explicit_consent"
    })
    settings["agent_providers"] = {
        "agent_providers_version": 1,
        "default_provider_profile_id": profile.profile_id,
        "agents": {
            "canon_checker": {"provider_source": "project_default", "model_id": None},
            "impact_resolver": {"provider_source": "project_default", "model_id": None},
            "style_rewriter": {"provider_source": "project_default", "model_id": "style-model"},
        },
    }
    source = tmp_path / "configured.json"
    source.write_text(json.dumps(payload))
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(source, project_path)
    coordinator_holder: list[StyleRewriteCoordinator] = []

    def invalidate(project_id: str) -> None:
        """Mirror production invalidation after a successful authoring command."""

        if coordinator_holder:
            coordinator_holder[0].invalidate_project(project_id)

    sessions = ProjectSessionRegistry(on_authoring_committed=invalidate)
    opened = sessions.open(project_path)
    selected_agent = agent or _Agent()
    coordinator = StyleRewriteCoordinator(sessions, profiles, agent=selected_agent)
    coordinator_holder.append(coordinator)
    return sessions, coordinator, opened.session.session_id, selected_agent


def _request(sessions: ProjectSessionRegistry, session_id: str) -> StyleRewriteRequestV1:
    current = sessions.inspect(session_id)
    return StyleRewriteRequestV1(
        session_id=session_id,
        target={"kind": "node_text", "node_id": "node-customs-office"},
        observed_source_checksum=current.document.checksum,
        expected_history_revision=sessions.inspect_history(session_id).history_revision,
        content_consent=True,
    )


def _poll(coordinator: StyleRewriteCoordinator, session_id: str, run_id: str):
    """Poll process-local work without coupling tests to executor timing."""

    for _ in range(200):
        run = coordinator.inspect(session_id, run_id)
        if run.status in TERMINAL:
            return run
        sleep(0.01)
    raise AssertionError("style rewrite did not complete")
