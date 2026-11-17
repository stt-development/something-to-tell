from pathlib import Path

import pytest

from services.runtime.stt_runtime.canon.projection import CanonFactProjector
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import (
    ProjectSessionError,
    ProjectSessionRegistry,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


def _open_aurora(tmp_path: Path) -> tuple[ProjectSessionRegistry, str]:
    project_path = tmp_path / "ProjectAurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    registry = ProjectSessionRegistry()
    opened = registry.open(project_path)
    return registry, opened.session.session_id


def test_aurora_projection_is_complete_ordered_and_deterministic(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        captured = registry.capture_canon_input(session_id, rule_pack_version=3)
        repeated = CanonFactProjector().project(captured.document, rule_pack_version=3)
    finally:
        registry.close(session_id)

    assert captured.model_dump(mode="json") == repeated.model_dump(mode="json")
    assert captured.project_id == "project-aurora"
    assert captured.saved_revision == 1
    assert captured.source_checksum == captured.document.checksum
    assert captured.rule_pack_version == 3
    assert {fact.domain for fact in captured.facts} == {
        "graph",
        "composition",
        "flow",
        "dialogue",
        "quest",
        "temporal",
        "playback",
    }
    assert all(fact.source_revision == 1 for fact in captured.facts)
    assert all(fact.evidence and fact.evidence[0].owner.owner_id for fact in captured.facts)


def test_aurora_projection_preserves_specific_domain_owners(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        facts = registry.capture_canon_input(session_id).facts
    finally:
        registry.close(session_id)

    by_code = {}
    for fact in facts:
        by_code.setdefault(fact.code, []).append(fact)

    relationship = next(
        fact
        for fact in by_code["graph.relationship"]
        if fact.scope.owner_id == "edge-guild-ledger"
    )
    assert {(owner.owner_type, owner.owner_id) for owner in relationship.owners} == {
        ("node", "node-trade-guild"),
        ("node", "node-sealed-ledger"),
    }
    assert any(
        fact.scope.owner_type == "quest_stage"
        and fact.scope.context_id == "node-smuggler-route"
        for fact in by_code["quest.stage"]
    )
    assert any(
        fact.scope.owner_type == "quest_branch"
        and any(owner.owner_id == "node-smuggler-route" for owner in fact.owners)
        for fact in by_code["quest.branch"]
    )
    assert any(
        fact.scope.owner_type == "dialogue_option"
        and any(owner.owner_id == "node-dock-dialogue" for owner in fact.owners)
        for fact in by_code["dialogue.option"]
    )
    assert any(
        {owner.owner_type for owner in fact.owners} == {"effect", "quest_outcome"}
        for fact in by_code["temporal.effect-binding"]
    )
    assert [fact.level for fact in by_code["flow.cycle"]] == ["info"]
    assert [fact.level for fact in by_code["playback.definition-ready"]] == ["info"]


def test_projection_does_not_infer_false_contradictions_from_valid_authoring(
    tmp_path: Path,
) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        facts = registry.capture_canon_input(session_id).facts
    finally:
        registry.close(session_id)

    # Canonical nodes may intentionally remain outside every Story Flow.
    assert not any(
        fact.code == "flow.unreachable_member"
        and any(owner.owner_id == "node-harbor" for owner in fact.owners)
        for fact in facts
    )
    # Linked instances in different scopes are valid composition reuse.
    assert not any(
        fact.code == "composition.duplicate_placement"
        and any(
            owner.owner_id in {"node-dockmaster", "node-sealed-ledger"}
            for owner in fact.owners
        )
        for fact in facts
    )
    # Semantic owns edges and temporal custody remain separate inputs here.
    assert not any("contradict" in fact.code or "custody-conflict" in fact.code for fact in facts)
    assert any(fact.code == "graph.relationship" for fact in facts)
    assert any(fact.code == "temporal.initial-state" for fact in facts)


def test_dirty_session_captures_the_current_working_document(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        before = registry.capture_canon_input(session_id)
        registry.mark_dirty(session_id)
        captured = registry.capture_canon_input(session_id)
    finally:
        registry.discard(session_id)
        registry.close(session_id)

    assert captured.source_checksum == before.source_checksum
    assert captured.saved_revision == before.saved_revision


def test_capture_ignores_obsolete_checkpoint_checksum_for_working_analysis(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        active = registry._require_session(session_id)
        active.saved_checksum = "0" * 64
        captured = registry.capture_canon_input(session_id)
    finally:
        registry.close(session_id)

    assert captured.source_checksum != "0" * 64
