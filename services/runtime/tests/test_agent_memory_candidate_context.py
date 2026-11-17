"""Candidate context tests keep remote disclosure exact and bounded."""

from pathlib import Path

import pytest

from services.runtime.stt_runtime.agent_memory.candidate_context import (
    AgentMemoryCandidateContextBuilder,
    AgentMemoryCandidateContextError,
)
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.schemas.agent_memory_candidate import (
    AGENT_MEMORY_MAX_TARGET_CHARACTERS,
    AgentMemoryCandidateRequestV1,
)
from services.runtime.stt_runtime.schemas.project_document import create_project_document

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"


def _document():
    fixture = load_project_fixture(FIXTURE)
    # Fixture-only metadata and playback traces are not canonical authoring data.
    return create_project_document(
        manifest=fixture.manifest,
        project_metadata=fixture.project_metadata,
        nodes=fixture.nodes,
        edges=fixture.edges,
        issues=fixture.issues,
        suggestions=fixture.suggestions,
        engine_tags=fixture.engine_tags,
        placements=fixture.placements,
        dialogues=fixture.dialogues,
        quests=fixture.quests,
        story_flows=fixture.story_flows,
        story_flow_nodes=fixture.story_flow_nodes,
        flow_transitions=fixture.flow_transitions,
        scene_flow_boundaries=fixture.scene_flow_boundaries,
        flow_invocations=fixture.flow_invocations,
        flow_exits=fixture.flow_exits,
        flow_exit_bindings=fixture.flow_exit_bindings,
        flow_initial_states=fixture.flow_initial_states,
        narrative_effects=fixture.narrative_effects,
        narrative_effect_bindings=fixture.narrative_effect_bindings,
        style_profiles=fixture.style_profiles,
        scene_style_assignments=fixture.scene_style_assignments,
        agent_memories=fixture.agent_memories,
    )


def _request(document, scope: dict[str, object]) -> AgentMemoryCandidateRequestV1:
    return AgentMemoryCandidateRequestV1.model_validate({
        "request_version": 1,
        "session_id": "session-test",
        "project_id": document.manifest.project_id,
        "agent_id": "style_rewriter",
        "namespace": "style_rewriter",
        "scope": scope,
        "content_locale": "en",
        "observed_source_checksum": document.checksum,
        "expected_history_revision": 0,
        "guidance_request": "Remember a reusable writing constraint.",
        "content_consent": True,
    })


def test_extracts_only_the_exact_dialogue_option() -> None:
    document = _document()
    request = _request(document, {
        "scope_version": 1,
        "kind": "dialogue_field",
        "node_id": "node-dock-dialogue",
        "field_kind": "option_text",
        "element_id": "choice-mara-response",
        "option_id": "answer-show-ledger",
    })

    context = AgentMemoryCandidateContextBuilder().build(document, request)

    assert context.target_kind == "option_text"
    assert context.target_text == "Show Ilya the sealed ledger."
    assert "Circle back" not in context.model_dump_json()
    assert "session" not in context.model_dump_json()
    assert "checksum" not in context.model_dump_json()


def test_truncates_large_target_and_rejects_a_missing_owner() -> None:
    document = _document()
    node = document.nodes[0]
    oversized = node.model_copy(update={"body": "x" * (AGENT_MEMORY_MAX_TARGET_CHARACTERS + 17)})
    document = create_project_document(**{
        **document.model_dump(mode="python", exclude={"checksum"}),
        "nodes": [oversized, *document.nodes[1:]],
    })
    context = AgentMemoryCandidateContextBuilder().build(
        document,
        _request(document, {"scope_version": 1, "kind": "node", "node_id": node.id}),
    )

    assert len(context.target_text) == AGENT_MEMORY_MAX_TARGET_CHARACTERS
    assert context.omitted_target_characters > 0

    with pytest.raises(AgentMemoryCandidateContextError) as raised:
        AgentMemoryCandidateContextBuilder().build(
            document,
            _request(document, {
                "scope_version": 1,
                "kind": "story_flow",
                "flow_id": "flow-missing",
            }),
        )
    assert raised.value.code == "agent_memory_resolution_target_missing"
