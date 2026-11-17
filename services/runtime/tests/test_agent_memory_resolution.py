"""Pure resolution tests cover every dispatch-affecting memory rule."""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest

from services.runtime.stt_runtime.agent_memory.resolver import (
    AgentMemoryResolutionError,
    AgentMemoryResolver,
    AgentMemorySnapshot,
)
from services.runtime.stt_runtime.schemas.agent_memory import (
    AgentMemoryEntryV1,
    AgentMemoryResolutionRequestV1,
)
from services.runtime.stt_runtime.schemas.dialogue import DialogueDocument
from services.runtime.stt_runtime.schemas.project_document import (
    OwnedDialogueDocument,
    ProjectDocument,
    ProjectNodeRecord,
    ProjectPlacementRecord,
)

NOW = datetime(2026, 9, 12, 10, 0, tzinfo=UTC)
PROJECT_ID = "project-memory-resolution"
CHECKSUM = "a" * 64


def _scope(kind: str, owner_id: str | None = None) -> dict[str, object]:
    if kind == "project":
        return {"scope_version": 1, "kind": "project"}
    if kind == "scene":
        return {"scope_version": 1, "kind": "scene", "scene_node_id": owner_id}
    if kind == "node":
        return {"scope_version": 1, "kind": "node", "node_id": owner_id}
    if kind == "story_flow":
        return {"scope_version": 1, "kind": "story_flow", "flow_id": owner_id}
    return {
        "scope_version": 1,
        "kind": "dialogue_field",
        "node_id": owner_id,
        "field_kind": "line_text",
        "element_id": "line-opening",
        "option_id": None,
    }


def _entry(
    memory_id: str,
    scope: dict[str, object],
    *,
    title: str | None = None,
    instruction: str | None = None,
    agent_id: str = "canon_checker",
    locale: str = "en",
    status: str = "active",
    supersedes_id: str | None = None,
) -> AgentMemoryEntryV1:
    return AgentMemoryEntryV1.model_validate({
        "memory_version": 1,
        "id": memory_id,
        "project_id": PROJECT_ID,
        "agent_id": agent_id,
        "namespace": agent_id,
        "scope": scope,
        "content_locale": locale,
        "title": title or memory_id,
        "instruction": instruction or f"Apply {memory_id}.",
        "rationale": None,
        "status": status,
        "supersedes_id": supersedes_id,
        "created_at": NOW,
        "updated_at": NOW,
    })


def _node(node_id: str, kind: str) -> ProjectNodeRecord:
    return ProjectNodeRecord(
        id=node_id,
        project_id=PROJECT_ID,
        type=kind,
        title=node_id,
        status="canon",
        created_at=NOW,
        updated_at=NOW,
    )


def _placement(
    placement_id: str,
    node_id: str,
    container_id: str | None,
) -> ProjectPlacementRecord:
    return ProjectPlacementRecord(
        id=placement_id,
        project_id=PROJECT_ID,
        canonical_node_id=node_id,
        scope_key=container_id or "root",
        x=0,
        y=0,
        width=240,
        height=140,
        container_node_id=container_id,
        is_primary=container_id is None,
        presentation_state="expanded",
        created_at=NOW,
        updated_at=NOW,
    )


def _snapshot(
    *,
    entries: tuple[AgentMemoryEntryV1, ...],
    nodes: tuple[ProjectNodeRecord, ...] = (),
    placements: tuple[ProjectPlacementRecord, ...] = (),
    flow_ids: frozenset[str] = frozenset(),
    flow_memberships: frozenset[tuple[str, str]] = frozenset(),
    dialogue_fields: frozenset[tuple[str, str, str, str | None]] = frozenset(),
) -> AgentMemorySnapshot:
    return AgentMemorySnapshot(
        project_id=PROJECT_ID,
        source_checksum=CHECKSUM,
        history_revision=7,
        entries=entries,
        nodes=nodes,
        placements=placements,
        flow_ids=flow_ids,
        flow_memberships=flow_memberships,
        dialogue_fields=dialogue_fields,
    )


def _request(
    scope: dict[str, object],
    context_scope: dict[str, object] | None = None,
    **overrides: object,
) -> AgentMemoryResolutionRequestV1:
    payload: dict[str, object] = {
        "resolution_version": 1,
        "project_id": PROJECT_ID,
        "agent_id": "canon_checker",
        "namespace": "canon_checker",
        "scope": scope,
        "content_locale": "en",
        "context_scope": context_scope or _scope("project"),
        "source_checksum": CHECKSUM,
        "history_revision": 7,
    }
    payload.update(overrides)
    return AgentMemoryResolutionRequestV1.model_validate(payload)


def test_orders_exact_context_and_project_scopes_then_stable_ids() -> None:
    entries = (
        _entry("project-z", _scope("project")),
        _entry("scene-b", _scope("scene", "scene-docks")),
        _entry("exact-z", _scope("node", "event-arrival")),
        _entry("exact-a", _scope("node", "event-arrival")),
        _entry("scene-a", _scope("scene", "scene-docks")),
        _entry("project-a", _scope("project")),
        _entry("other-node", _scope("node", "event-other")),
        _entry("impact-hidden", _scope("project"), agent_id="impact_resolver"),
        _entry("russian-hidden", _scope("project"), locale="ru"),
    )
    snapshot = _snapshot(
        entries=entries,
        nodes=(
            _node("scene-docks", "Scene"),
            _node("event-arrival", "Event"),
            _node("event-other", "Event"),
        ),
        placements=(_placement("arrival-docks", "event-arrival", "scene-docks"),),
    )

    result = AgentMemoryResolver().resolve(
        snapshot,
        _request(
            _scope("node", "event-arrival"),
            _scope("scene", "scene-docks"),
        ),
    )

    assert result.status == "resolved"
    assert [entry.id for entry in result.entries] == [
        "exact-a", "exact-z", "scene-a", "scene-b", "project-a", "project-z"
    ]
    assert [(item.memory_id, item.reason) for item in result.omissions] == [
        ("other-node", "out_of_scope")
    ]
    assert "impact-hidden" not in result.model_dump_json()
    assert "russian-hidden" not in result.model_dump_json()


def test_shared_node_requires_explicit_scene_but_nested_locations_are_valid() -> None:
    snapshot = _snapshot(
        entries=(_entry("scene-rule", _scope("scene", "scene-alpha")),),
        nodes=(
            _node("scene-alpha", "Scene"),
            _node("scene-beta", "Scene"),
            _node("location-yard", "Location"),
            _node("location-vault", "Location"),
            _node("character-shared", "Character"),
        ),
        placements=(
            _placement("yard-alpha", "location-yard", "scene-alpha"),
            _placement("vault-yard", "location-vault", "location-yard"),
            _placement("shared-vault", "character-shared", "location-vault"),
            _placement("shared-beta", "character-shared", "scene-beta"),
        ),
    )
    with pytest.raises(AgentMemoryResolutionError) as raised:
        AgentMemoryResolver().resolve(
            snapshot,
            _request(_scope("node", "character-shared")),
        )

    result = AgentMemoryResolver().resolve(
        snapshot,
        _request(
            _scope("node", "character-shared"),
            _scope("scene", "scene-alpha"),
        ),
    )

    assert raised.value.code == "agent_memory_resolution_context_required"
    assert raised.value.parameters["scene_node_ids"] == ["scene-alpha", "scene-beta"]
    assert [entry.id for entry in result.entries] == ["scene-rule"]


def test_scene_context_rejects_geometry_without_valid_location_containment() -> None:
    snapshot = _snapshot(
        entries=(),
        nodes=(
            _node("scene-alpha", "Scene"),
            _node("faction-shell", "Faction"),
            _node("item-key", "Item"),
        ),
        placements=(
            _placement("faction-scene", "faction-shell", "scene-alpha"),
            _placement("key-faction", "item-key", "faction-shell"),
        ),
    )

    with pytest.raises(AgentMemoryResolutionError) as raised:
        AgentMemoryResolver().resolve(
            snapshot,
            _request(_scope("node", "item-key"), _scope("scene", "scene-alpha")),
        )

    assert raised.value.code == "agent_memory_resolution_context_invalid"


def test_story_flow_context_requires_membership_and_applies_flow_memory() -> None:
    snapshot = _snapshot(
        entries=(_entry("flow-rule", _scope("story_flow", "flow-main")),),
        nodes=(_node("quest-gate", "Quest"),),
        flow_ids=frozenset({"flow-main"}),
        flow_memberships=frozenset({("flow-main", "quest-gate")}),
    )
    result = AgentMemoryResolver().resolve(
        snapshot,
        _request(_scope("node", "quest-gate"), _scope("story_flow", "flow-main")),
    )

    assert [entry.id for entry in result.entries] == ["flow-rule"]

    without_membership = _snapshot(
        entries=snapshot.entries,
        nodes=snapshot.nodes,
        flow_ids=snapshot.flow_ids,
    )
    with pytest.raises(AgentMemoryResolutionError) as raised:
        AgentMemoryResolver().resolve(
            without_membership,
            _request(_scope("node", "quest-gate"), _scope("story_flow", "flow-main")),
        )
    assert raised.value.code == "agent_memory_resolution_context_invalid"


def test_conflicting_active_topics_block_dispatch_with_repair_details() -> None:
    entries = (
        _entry(
            "exact-ownership", _scope("node", "item-ledger"),
            title="Ledger ownership", instruction="The ledger belongs to Ilya.",
        ),
        _entry(
            "project-ownership", _scope("project"),
            title="ledger OWNERSHIP", instruction="The ledger belongs to Mara.",
        ),
        _entry("project-tone", _scope("project")),
    )
    result = AgentMemoryResolver().resolve(
        _snapshot(entries=entries, nodes=(_node("item-ledger", "Item"),)),
        _request(_scope("node", "item-ledger")),
    )

    assert result.status == "blocked"
    assert result.entries == ()
    assert result.conflicts[0].memory_ids == (
        "exact-ownership", "project-ownership"
    )
    assert result.conflicts[0].repair_actions == ("archive", "supersede")
    assert {item.memory_id: item.reason for item in result.omissions} == {
        "exact-ownership": "conflict",
        "project-ownership": "conflict",
        "project-tone": "resolution_blocked",
    }


def test_same_topic_with_equal_instructions_is_not_a_conflict() -> None:
    entries = (
        _entry(
            "exact-rule", _scope("node", "item-ledger"),
            title="Ledger ownership", instruction="Keep Ilya as owner.",
        ),
        _entry(
            "project-rule", _scope("project"),
            title="ledger OWNERSHIP", instruction="keep ilya AS OWNER.",
        ),
    )

    result = AgentMemoryResolver().resolve(
        _snapshot(entries=entries, nodes=(_node("item-ledger", "Item"),)),
        _request(_scope("node", "item-ledger")),
    )

    assert result.status == "resolved"
    assert [entry.id for entry in result.entries] == ["exact-rule", "project-rule"]
    assert result.conflicts == ()


def test_invalid_owners_block_dispatch_while_lifecycle_omissions_remain_inspectable() -> None:
    entries = (
        _entry("archived", _scope("project"), status="archived"),
        _entry("old-rule", _scope("project")),
        _entry(
            "successor", _scope("project"), status="archived",
            supersedes_id="old-rule",
        ),
        _entry("missing-node", _scope("node", "node-gone")),
        _entry("stale-field", _scope("dialogue_field", "dialogue-gate")),
        _entry("active", _scope("project")),
    )
    result = AgentMemoryResolver().resolve(
        _snapshot(entries=entries, nodes=(_node("dialogue-gate", "Dialogue"),)),
        _request(_scope("project")),
    )

    assert result.status == "blocked"
    assert result.entries == ()
    assert {item.memory_id: item.reason for item in result.omissions} == {
        "active": "resolution_blocked",
        "archived": "archived",
        "missing-node": "missing_owner",
        "old-rule": "superseded",
        "stale-field": "stale_owner",
        "successor": "archived",
    }


def test_entry_and_character_limits_report_exact_omitted_ids() -> None:
    entries = tuple(
        _entry(memory_id, _scope("project"), instruction="12345")
        for memory_id in ("memory-a", "memory-b", "memory-c", "memory-d")
    )
    request = _request(_scope("project"))

    entry_limited = AgentMemoryResolver().resolve(
        _snapshot(entries=entries), request, max_entries=2
    )
    character_limited = AgentMemoryResolver().resolve(
        _snapshot(entries=entries),
        request,
        max_characters=len("memory-a") + len("12345"),
    )

    assert [entry.id for entry in entry_limited.entries] == ["memory-a", "memory-b"]
    assert [(item.memory_id, item.reason) for item in entry_limited.omissions] == [
        ("memory-c", "entry_limit"), ("memory-d", "entry_limit")
    ]
    assert [entry.id for entry in character_limited.entries] == ["memory-a"]
    assert all(item.reason == "character_limit" for item in character_limited.omissions)
    assert [item.memory_id for item in character_limited.omissions] == [
        "memory-b", "memory-c", "memory-d"
    ]


def test_stale_project_binding_blocks_resolution_before_selection() -> None:
    with pytest.raises(AgentMemoryResolutionError) as raised:
        AgentMemoryResolver().resolve(
            _snapshot(entries=()),
            _request(_scope("project"), history_revision=6),
        )

    assert raised.value.code == "agent_memory_resolution_stale"
    assert raised.value.parameters["history_revision"] == 7


def test_missing_exact_target_blocks_resolution_with_safe_scope_identity() -> None:
    with pytest.raises(AgentMemoryResolutionError) as raised:
        AgentMemoryResolver().resolve(
            _snapshot(entries=()),
            _request(_scope("node", "node-gone")),
        )

    assert raised.value.code == "agent_memory_resolution_target_missing"
    assert raised.value.parameters == {
        "owner_state": "missing_owner",
        "target_scope": "node:node-gone",
    }


def test_snapshot_projects_dialogue_fields_and_flow_memberships_from_document() -> None:
    dialogue = DialogueDocument.model_validate({
        "dialogue_version": 1,
        "entry_element_id": "line-opening",
        "participants": ["character-ilya"],
        "elements": [
            {
                "id": "line-opening",
                "kind": "line",
                "speaker_node_id": "character-ilya",
                "text": "State your purpose.",
                "next_element_id": "choice-answer",
            },
            {
                "id": "choice-answer",
                "kind": "choice",
                "prompt": "Choose an answer",
                "options": [
                    {
                        "id": "option-ledger",
                        "text": "Show the ledger.",
                        "condition": "",
                        "next_element_id": None,
                    }
                ],
            },
        ],
    })
    # model_construct keeps this unit focused on projection rather than the
    # complete ProjectDocument fixture and checksum validator.
    document = ProjectDocument.model_construct(
        checksum=CHECKSUM,
        manifest=SimpleNamespace(project_id=PROJECT_ID),
        agent_memories=[],
        nodes=[],
        placements=[],
        story_flows=[SimpleNamespace(id="flow-main")],
        story_flow_nodes=[SimpleNamespace(flow_id="flow-main", node_id="dialogue-gate")],
        dialogues=[OwnedDialogueDocument(node_id="dialogue-gate", document=dialogue)],
    )

    snapshot = AgentMemorySnapshot.from_document(
        cast(ProjectDocument, document), history_revision=9
    )

    assert snapshot.history_revision == 9
    assert snapshot.flow_memberships == frozenset({("flow-main", "dialogue-gate")})
    assert snapshot.dialogue_fields == frozenset({
        ("dialogue-gate", "line_text", "line-opening", None),
        ("dialogue-gate", "choice_prompt", "choice-answer", None),
        ("dialogue-gate", "option_text", "choice-answer", "option-ledger"),
    })
