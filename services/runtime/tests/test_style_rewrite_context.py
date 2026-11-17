"""Bounded and deterministic Style Rewriter context coverage."""

import json
from pathlib import Path

import pytest

from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.style_rewrite import StyleRewriteRequestV1
from services.runtime.stt_runtime.style_system.rewrite_context import (
    StyleRewriteContextBuilder,
    StyleRewriteContextError,
)
from services.runtime.stt_runtime.style_system.resolver import (
    EffectiveStyleResolver,
    StyleResolutionSnapshot,
)

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
CITADEL_FIXTURE = Path(__file__).parents[3] / "fixtures/projects/citadel-branch.v1.json"


def test_aurora_demonstrates_complete_style_context_and_dialogue_target_matrix(
    tmp_path: Path,
) -> None:
    """Keep the inspectable sample aligned with the Phase 6 authoring guide."""

    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        snapshot = StyleResolutionSnapshot.from_document(document)
        resolver = EffectiveStyleResolver()

        inherited = resolver.resolve(snapshot, target_node_id="node-hero")
        overridden = resolver.resolve(snapshot, target_node_id="node-dock-dialogue")
        nested = resolver.resolve(snapshot, target_node_id="node-customs-office")
        shared = resolver.resolve(snapshot, target_node_id="node-sealed-ledger")
        ledger_placements = [
            placement
            for placement in document.placements
            if placement.canonical_node_id == "node-sealed-ledger"
        ]
        dialogue = next(
            item for item in document.dialogues
            if item.node_id == "node-dock-dialogue"
        ).document

        assert len(document.style_profiles) >= 2
        assert document.manifest.settings.style_system.default_style_profile_id == (
            "style-aurora-default"
        )
        assert document.scene_style_assignments[0].scene_node_id == "node-opening"
        assert inherited.source == "project_default"
        assert overridden.source == nested.source == shared.source == "scene_override"
        assert nested.scene_context is not None
        assert nested.scene_context.scene_node_id == "node-opening"
        assert len(ledger_placements) == 2
        assert any(placement.container_node_id is None for placement in ledger_placements)
        assert any(
            placement.container_node_id == "node-opening"
            for placement in ledger_placements
        )
        assert any(element.kind == "line" for element in dialogue.elements)
        assert any(
            element.kind == "choice" and element.prompt and element.options
            for element in dialogue.elements
        )
    finally:
        sessions.close_all()


def test_citadel_remains_without_authored_style_configuration(tmp_path: Path) -> None:
    """The baseline fixture must not silently inherit Aurora demonstration data."""

    project_path = tmp_path / "Citadel.narrative"
    import_project_fixture(CITADEL_FIXTURE, project_path)
    sessions = ProjectSessionRegistry()
    opened = sessions.open(project_path)
    try:
        document = opened.document
        assert document.style_profiles == []
        assert document.scene_style_assignments == []
        assert document.manifest.settings.style_system.default_style_profile_id is None
    finally:
        sessions.close_all()


def test_dialogue_context_contains_exact_field_and_bounded_neighbors(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        opened = sessions.inspect(session_id)
        request = StyleRewriteRequestV1(
            session_id=session_id,
            target={
                "kind": "dialogue_field",
                "node_id": "node-dock-dialogue",
                "field_kind": "option_text",
                "element_id": "choice-mara-response",
                "option_id": "answer-show-ledger",
            },
            style_context={"scene_node_id": "node-opening"},
            observed_source_checksum=opened.document.checksum,
            expected_history_revision=0,
            additional_instructions="Make the decision terse.",
            content_consent=True,
        )

        context = StyleRewriteContextBuilder().build(opened.document, 0, request)

        assert context.source_text == "Show Ilya the sealed ledger."
        assert context.style_profile_id == "style-aurora-test-luna"
        assert context.style_guidance.startswith("Polish the selected prose")
        assert [item.memory_id for item in context.approved_memory.entries] == [
            "memory-style-03-dialogue-ledger-en",
            "memory-style-02-scene-opening-en",
            "memory-style-01-project-en",
        ]
        assert context.approved_memory.agent_id == "style_rewriter"
        assert context.content_locale == "en"
        assert len(context.adjacent_lines) == 4
        assert [item.element_id for item in context.adjacent_lines] == [
            "line-dockmaster-warning",
            "line-mara-challenge",
            "line-ilya-concedes",
            "line-mara-orders-run",
        ]
        assert "Project Aurora" not in context.model_dump_json()
        assert "private" not in context.model_dump_json()
        # Context assembly is read-only; provider prose can never become memory
        # without a later candidate review and explicit history command.
        assert len(opened.document.agent_memories) == 10
    finally:
        sessions.close_all()


def test_common_node_text_rejects_divergent_legacy_fields(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        opened = sessions.inspect(session_id)
        document = opened.document.model_copy(deep=True)
        target = next(item for item in document.nodes if item.id == "node-customs-office")
        target.summary = "Summary"
        target.body = "Different body"
        request = StyleRewriteRequestV1(
            session_id=session_id,
            target={"kind": "node_text", "node_id": target.id},
            observed_source_checksum=document.checksum,
            expected_history_revision=0,
            content_consent=True,
        )

        with pytest.raises(StyleRewriteContextError) as raised:
            StyleRewriteContextBuilder().build(document, 0, request)

        assert raised.value.code == "style_node_text_conflict"
    finally:
        sessions.close_all()


@pytest.mark.parametrize(
    ("target", "expected_text"),
    [
        (
            {
                "kind": "quest_field",
                "node_id": "node-smuggler-route",
                "field_kind": "objective",
                "stage_id": None,
            },
            "Secure proof of the forged embargo and open a route out of Glass Harbor.",
        ),
        (
            {
                "kind": "quest_field",
                "node_id": "node-smuggler-route",
                "field_kind": "stage_description",
                "stage_id": "stage-secure-ledger",
            },
            "Recover evidence that the Trade Guild forged the embargo order.",
        ),
    ],
)
def test_quest_context_reads_the_exact_authored_field(
    tmp_path: Path,
    target: dict,
    expected_text: str,
) -> None:
    """Quest recommendations must receive only the selected prose field."""

    sessions, session_id = _open_aurora(tmp_path)
    try:
        opened = sessions.inspect(session_id)
        request = StyleRewriteRequestV1(
            session_id=session_id,
            target=target,
            observed_source_checksum=opened.document.checksum,
            expected_history_revision=0,
            content_consent=True,
        )

        context = StyleRewriteContextBuilder().build(opened.document, 0, request)

        assert context.source_text == expected_text
        assert context.target.kind == "quest_field"
    finally:
        sessions.close_all()


def _open_aurora(tmp_path: Path) -> tuple[ProjectSessionRegistry, str]:
    """Import the portable fixture so tests exercise real document invariants."""

    fixture = json.loads(FIXTURE.read_text())
    fixture_file = tmp_path / "aurora.json"
    fixture_file.write_text(json.dumps(fixture))
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(fixture_file, project_path)
    sessions = ProjectSessionRegistry()
    opened = sessions.open(project_path)
    return sessions, opened.session.session_id
