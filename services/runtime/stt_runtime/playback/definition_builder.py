from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..domain.entities import NodeEntity
from ..schemas.dialogue import DialogueDocument
from ..schemas.composable_story_flow import ComposableFlowGraph
from ..schemas.playback import (
    PlaybackCanonicalNode,
    PlaybackDefinition,
    PlaybackFact,
    PlaybackPreparation,
    PlaybackState,
    PlaybackTypedEffect,
)
from ..schemas.quest import QuestDocument
from ..schemas.story_flow import StoryFlowSnapshot

EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)


def build_playback_definition(
    snapshot: StoryFlowSnapshot | Mapping[str, Any],
    canonical_nodes: Sequence[NodeEntity | PlaybackCanonicalNode],
    dialogue_documents: Mapping[str, DialogueDocument | Mapping[str, Any]],
    quest_documents: Mapping[str, QuestDocument | Mapping[str, Any]],
    typed_effects: Sequence[PlaybackTypedEffect | Mapping[str, Any]],
    initial_state: PlaybackState | Mapping[str, Any] | None = None,
    *,
    source_revision: str,
    snapshots: Sequence[Mapping[str, Any]] = (),
) -> PlaybackPreparation:
    """Build a normalized definition or stable facts without mutating authoring data."""

    raw_snapshot = snapshot.model_dump(mode="python") if isinstance(snapshot, StoryFlowSnapshot) else dict(snapshot)
    project_id, flow_id = _snapshot_owners(raw_snapshot)
    raw_snapshots = [dict(item) for item in snapshots] if snapshots else [raw_snapshot]
    if not any(_snapshot_owners(item)[1] == flow_id for item in raw_snapshots):
        raw_snapshots.insert(0, raw_snapshot)
    facts: list[PlaybackFact] = []
    parsed_snapshots: list[StoryFlowSnapshot] = []
    try:
        for item in raw_snapshots:
            item_project_id, item_flow_id = _snapshot_owners(item)
            if item_project_id != project_id:
                facts.append(_fact("stale_ownership", "Story Flow belongs to another project.", "Remove the foreign Flow from Playback.", flow_id=item_flow_id))
                continue
            item_facts = _preflight_snapshot(item, project_id, item_flow_id)
            facts.extend(item_facts)
            if item_facts:
                continue
            parsed_snapshots.append(StoryFlowSnapshot.model_validate(_story_snapshot_fields(item)))
    except ValidationError:
        return _failed(
            project_id,
            flow_id,
            [_fact("invalid_definition", "Story Flow snapshot is invalid.", "Repair the Story Flow before Playback.", flow_id=flow_id)],
        )

    if facts:
        return _failed(project_id, flow_id, facts)
    parsed_by_id = {item.flow.id: item for item in parsed_snapshots}
    parsed_snapshot = parsed_by_id.get(flow_id or "")
    if parsed_snapshot is None:
        return _failed(project_id, flow_id, [_fact("invalid_definition", "Root Story Flow snapshot is missing.", "Include the selected Flow in Playback.", flow_id=flow_id)])
    members = [
        membership
        for item in parsed_snapshots
        for membership in sorted(item.nodes, key=lambda candidate: (candidate.presentation_order, candidate.id))
    ]
    member_ids = {membership.node_id for membership in members}
    memberships_by_flow = {
        item.flow.id: {membership.node_id for membership in item.nodes}
        for item in parsed_snapshots
    }
    nodes_by_id: dict[str, NodeEntity | PlaybackCanonicalNode] = {}
    duplicate_node_ids: set[str] = set()
    for node in canonical_nodes:
        if node.id in nodes_by_id:
            duplicate_node_ids.add(node.id)
        nodes_by_id[node.id] = node
    for node_id in sorted(duplicate_node_ids):
        facts.append(
            _fact(
                "stale_ownership",
                f"Canonical node '{node_id}' was supplied more than once.",
                "Supply one canonical record for each flow member.",
                flow_id=flow_id,
                node_id=node_id,
            )
        )
    for membership in members:
        node = nodes_by_id.get(membership.node_id)
        if node is None:
            facts.append(
                _fact(
                    "missing_member",
                    f"Flow member '{membership.node_id}' has no canonical node.",
                    "Restore the node or remove its flow membership.",
                    flow_id=flow_id,
                    node_id=membership.node_id,
                )
            )
        elif node.project_id != project_id:
            facts.append(
                _fact(
                    "stale_ownership",
                    f"Canonical node '{node.id}' belongs to another project.",
                    "Replace it with the project-owned canonical node.",
                    flow_id=flow_id,
                    node_id=node.id,
                )
            )
    parsed_dialogues = _parse_documents(dialogue_documents, DialogueDocument, "Dialogue", flow_id, facts)
    parsed_quests = _parse_documents(quest_documents, QuestDocument, "Quest", flow_id, facts)
    effects = _parse_effects(typed_effects, flow_id, facts)
    try:
        parsed_initial_state = PlaybackState.model_validate(initial_state or {})
    except ValidationError:
        return _failed(project_id, flow_id, [_fact("stale_ownership", "Playback initial state is invalid.", "Repair the root Flow initial state.", flow_id=flow_id)])
    referenced_node_ids = {
        *parsed_initial_state.item_holders,
        *parsed_initial_state.quest_states,
        *(
            holder.node_id
            for holder in parsed_initial_state.item_holders.values()
            if holder.node_id is not None
        ),
        *(node_id for effect in effects for node_id in _effect_target_ids(effect)),
    }
    for node_id in sorted(referenced_node_ids):
        node = nodes_by_id.get(node_id)
        if node is None or node.project_id != project_id:
            facts.append(_fact(
                "stale_ownership",
                f"State or effect target '{node_id}' has no project-owned canonical node.",
                "Restore the referenced node or repair the authored state/effect.",
                flow_id=flow_id,
                node_id=node_id,
            ))
    for node in sorted(canonical_nodes, key=lambda item: item.id):
        if node.id not in member_ids and (node.project_id != project_id or node.id not in referenced_node_ids):
            facts.append(
                _fact(
                    "stale_ownership",
                    f"Canonical node '{node.id}' is not required by this Playback definition.",
                    "Remove it or reference it from Flow state or an accepted effect.",
                    flow_id=flow_id,
                    node_id=node.id,
                )
            )

    for owner_id in sorted(parsed_dialogues):
        owner = nodes_by_id.get(owner_id)
        if owner is None or owner.type != "Dialogue" or owner_id not in member_ids:
            facts.append(
                _fact(
                    "stale_ownership",
                    f"Dialogue '{owner_id}' has a stale Playback owner.",
                    "Attach the document to a Dialogue member in this flow.",
                    flow_id=flow_id,
                    node_id=owner_id,
                )
            )
    for owner_id in sorted(parsed_quests):
        owner = nodes_by_id.get(owner_id)
        if owner is None or owner.type != "Quest" or owner_id not in member_ids:
            facts.append(
                _fact(
                    "stale_ownership",
                    f"Quest '{owner_id}' has a stale Playback owner.",
                    "Attach the document to a Quest member in this flow.",
                    flow_id=flow_id,
                    node_id=owner_id,
                )
            )
    transition_ids = {transition.id for item in parsed_snapshots for transition in item.transitions}
    invocation_ids = {record.get("id") for item in raw_snapshots for record in item.get("invocations", [])}
    exit_ids = {record.get("id") for item in raw_snapshots for record in item.get("exits", [])}
    temporal_edge_ids = transition_ids | invocation_ids | exit_ids
    for effect in effects:
        stale = (
            effect.project_id != project_id
            or effect.flow_id not in memberships_by_flow
            or (effect.owner_node_id is not None and effect.owner_node_id not in memberships_by_flow.get(effect.flow_id, set()))
            or (effect.owner_transition_id is not None and effect.owner_transition_id not in temporal_edge_ids)
        )
        if stale:
            facts.append(
                _fact(
                    "stale_ownership",
                    f"Effect '{effect.id}' has stale project, flow, or source ownership.",
                    "Repair and re-review the typed effect.",
                    flow_id=flow_id,
                    node_id=effect.owner_node_id,
                    transition_id=effect.owner_transition_id,
                    effect_id=effect.id,
                )
            )
    if facts:
        return _failed(project_id, flow_id, facts)

    normalized_snapshots = [_normalize_snapshot(item) for item in parsed_snapshots]
    normalized_snapshot = next(item for item in normalized_snapshots if item.flow.id == flow_id)
    ordered_member_ids = list(dict.fromkeys(membership.node_id for membership in members))
    ordered_definition_ids = [*ordered_member_ids, *sorted(referenced_node_ids - member_ids)]
    definition_nodes = [_canonical_node(nodes_by_id[node_id]) for node_id in ordered_definition_ids if node_id in nodes_by_id]
    try:
        composition = ComposableFlowGraph.model_validate({
            "project_id": project_id,
            "flows": [item.flow for item in normalized_snapshots],
            "memberships": [membership for item in normalized_snapshots for membership in item.nodes],
            "transitions": [transition for item in normalized_snapshots for transition in item.transitions],
            "invocations": [record for item in raw_snapshots for record in item.get("invocations", [])],
            "exits": [record for item in raw_snapshots for record in item.get("exits", [])],
            "bindings": [record for item in raw_snapshots for record in item.get("bindings", [])],
        })
        definition = PlaybackDefinition(
            project_id=project_id,
            flow_snapshot=normalized_snapshot,
            flow_snapshots=normalized_snapshots,
            composition=composition,
            canonical_nodes=definition_nodes,
            dialogue_documents={key: parsed_dialogues[key] for key in sorted(parsed_dialogues)},
            quest_documents={key: parsed_quests[key] for key in sorted(parsed_quests)},
            typed_effect_definitions=sorted(effects, key=lambda item: item.id),
            initial_state=parsed_initial_state,
            source_revision=source_revision,
        )
    except ValidationError:
        return _failed(
            project_id,
            flow_id,
            [_fact("stale_ownership", "Playback inputs have stale ownership.", "Rebuild reviewed Playback inputs.", flow_id=flow_id)],
        )
    return PlaybackPreparation(
        project_id=project_id,
        flow_id=flow_id,
        definition=definition,
    )


def _story_snapshot_fields(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Remove composition records before validating one local topology snapshot."""

    return {key: raw[key] for key in ("snapshot_version", "flow", "nodes", "transitions", "scene_boundaries", "scene_children") if key in raw}


def _normalize_snapshot(snapshot: StoryFlowSnapshot) -> StoryFlowSnapshot:
    """Sort one immutable Flow topology for deterministic hashing and traversal."""

    return snapshot.model_copy(update={
        "nodes": sorted(snapshot.nodes, key=lambda item: (item.presentation_order, item.id)),
        "transitions": sorted(snapshot.transitions, key=lambda item: (item.source_node_id, item.priority, item.id)),
        "scene_boundaries": sorted(snapshot.scene_boundaries, key=lambda item: (item.scene_node_id, item.id)),
        "scene_children": {key: sorted(value) for key, value in sorted(snapshot.scene_children.items())},
    }, deep=True)


def _preflight_snapshot(raw: Mapping[str, Any], project_id: str, flow_id: str | None) -> list[PlaybackFact]:
    facts: list[PlaybackFact] = []
    flow = raw.get("flow")
    if raw.get("snapshot_version", 1) != 1 or not isinstance(flow, Mapping) or flow.get("flow_version", 1) != 1:
        return [_fact("unsupported_version", "Story Flow uses an unsupported contract version.", "Migrate the project before Playback.", flow_id=flow_id)]
    memberships = raw.get("nodes", [])
    if not isinstance(memberships, list) or not memberships:
        return [_fact("empty_flow", "Story Flow has no members to play.", "Add at least one flow member and choose an entry.", flow_id=flow_id)]
    member_ids = {
        item.get("node_id")
        for item in memberships
        if isinstance(item, Mapping) and isinstance(item.get("node_id"), str)
    }
    entry = flow.get("entry_node_id")
    if not isinstance(entry, str):
        facts.append(_fact("missing_entry", "Story Flow has no Playback entry.", "Choose one flow member as entry.", flow_id=flow_id))
    elif entry not in member_ids:
        facts.append(_fact("invalid_entry", f"Entry '{entry}' is not a flow member.", "Choose an existing member as entry.", flow_id=flow_id, node_id=entry))
    for item in memberships:
        if isinstance(item, Mapping) and (
            item.get("project_id") != project_id or item.get("flow_id") != flow_id
        ):
            facts.append(
                _fact(
                    "stale_ownership",
                    f"Flow membership '{item.get('id', '<unknown>')}' has stale ownership.",
                    "Recreate the membership in this project and flow.",
                    flow_id=flow_id,
                    node_id=item.get("node_id") if isinstance(item.get("node_id"), str) else None,
                )
            )
    transitions = raw.get("transitions", [])
    if isinstance(transitions, list):
        for transition in transitions:
            if not isinstance(transition, Mapping):
                continue
            source = transition.get("source_node_id")
            target = transition.get("target_node_id")
            if source not in member_ids or target not in member_ids:
                facts.append(
                    _fact(
                        "dangling_source",
                        f"Transition '{transition.get('id', '<unknown>')}' has an endpoint outside flow membership.",
                        "Restore both endpoint memberships or remove the transition.",
                        flow_id=flow_id,
                        node_id=source if isinstance(source, str) else None,
                        transition_id=transition.get("id") if isinstance(transition.get("id"), str) else None,
                    )
                )
    return _sorted_facts(facts)


def _parse_documents(
    documents: Mapping[str, Any],
    contract: type[DialogueDocument] | type[QuestDocument],
    label: str,
    flow_id: str | None,
    facts: list[PlaybackFact],
) -> dict[str, DialogueDocument] | dict[str, QuestDocument]:
    parsed: dict[str, Any] = {}
    for owner_id, document in sorted(documents.items()):
        raw = document.model_dump(mode="python") if isinstance(document, contract) else document
        version_key = "dialogue_version" if label == "Dialogue" else "quest_version"
        if not isinstance(raw, Mapping) or raw.get(version_key, 1) != 1:
            facts.append(
                _fact(
                    "unsupported_version",
                    f"{label} '{owner_id}' uses an unsupported contract version.",
                    f"Migrate the {label} document before Playback.",
                    flow_id=flow_id,
                    node_id=owner_id,
                )
            )
            continue
        try:
            parsed[owner_id] = contract.model_validate(raw)
        except ValidationError:
            facts.append(
                _fact(
                    "invalid_definition",
                    f"{label} '{owner_id}' is invalid.",
                    f"Repair the {label} document before Playback.",
                    flow_id=flow_id,
                    node_id=owner_id,
                )
            )
    return parsed


def _parse_effects(
    effects: Sequence[PlaybackTypedEffect | Mapping[str, Any]],
    flow_id: str | None,
    facts: list[PlaybackFact],
) -> list[PlaybackTypedEffect]:
    parsed = []
    seen: set[str] = set()
    for raw_effect in effects:
        raw = raw_effect.model_dump(mode="python") if hasattr(raw_effect, "model_dump") else raw_effect
        effect_id = raw.get("id") if isinstance(raw, Mapping) else None
        if not isinstance(raw, Mapping) or raw.get("effect_version", 1) != 1:
            facts.append(
                _fact(
                    "unsupported_version",
                    f"Effect '{effect_id or '<unknown>'}' uses an unsupported contract version.",
                    "Re-review the effect with the current contract.",
                    flow_id=flow_id,
                    effect_id=effect_id if isinstance(effect_id, str) else None,
                )
            )
            continue
        if isinstance(effect_id, str) and effect_id in seen:
            facts.append(
                _fact(
                    "duplicate_effect_id",
                    f"Effect id '{effect_id}' is duplicated.",
                    "Assign every reviewed effect a unique id.",
                    flow_id=flow_id,
                    effect_id=effect_id,
                )
            )
            continue
        if isinstance(effect_id, str):
            seen.add(effect_id)
        try:
            parsed.append(EFFECT_ADAPTER.validate_python(raw))
        except ValidationError:
            facts.append(
                _fact(
                    "invalid_definition",
                    f"Effect '{effect_id or '<unknown>'}' is invalid.",
                    "Repair and re-review the typed effect.",
                    flow_id=flow_id,
                    effect_id=effect_id if isinstance(effect_id, str) else None,
                )
            )
    return parsed


def _effect_target_ids(effect: PlaybackTypedEffect) -> list[str]:
    """Collect canonical targets without treating them as playable Flow members."""

    if effect.operation == "transfer_item":
        return [
            effect.payload.item_node_id,
            *(holder.node_id for holder in (effect.payload.from_holder, effect.payload.to_holder) if holder.node_id),
        ]
    if effect.operation in {"add_inventory", "remove_inventory"}:
        return [effect.payload.node_id]
    if effect.operation == "set_quest_status":
        return [effect.payload.quest_node_id]
    if effect.operation == "record_dialogue_choice":
        return [effect.payload.dialogue_node_id]
    return []


def _canonical_node(node: NodeEntity | PlaybackCanonicalNode) -> PlaybackCanonicalNode:
    if isinstance(node, PlaybackCanonicalNode):
        return node.model_copy(deep=True)
    return PlaybackCanonicalNode(
        id=node.id,
        project_id=node.project_id,
        type=node.type,
        title=node.title,
        summary=node.summary,
        body=node.body,
        status=node.status,
        metadata=node.metadata,
    )


def _snapshot_owners(raw: Mapping[str, Any]) -> tuple[str, str | None]:
    flow = raw.get("flow")
    if not isinstance(flow, Mapping):
        return "unknown-project", None
    project_id = flow.get("project_id")
    flow_id = flow.get("id")
    return (
        project_id if isinstance(project_id, str) and project_id else "unknown-project",
        flow_id if isinstance(flow_id, str) and flow_id else None,
    )


def _fact(
    code: str,
    message: str,
    action: str,
    *,
    flow_id: str | None,
    node_id: str | None = None,
    transition_id: str | None = None,
    effect_id: str | None = None,
) -> PlaybackFact:
    return PlaybackFact(
        code=code,
        level="error",
        message=message,
        action=action,
        flow_id=flow_id,
        node_id=node_id,
        transition_id=transition_id,
        effect_id=effect_id,
    )


def _failed(project_id: str, flow_id: str | None, facts: Sequence[PlaybackFact]) -> PlaybackPreparation:
    return PlaybackPreparation(
        project_id=project_id,
        flow_id=flow_id,
        facts=_sorted_facts(facts),
    )


def _sorted_facts(facts: Sequence[PlaybackFact]) -> list[PlaybackFact]:
    return sorted(
        facts,
        key=lambda fact: (
            fact.code,
            fact.flow_id or "",
            fact.node_id or "",
            fact.transition_id or "",
            fact.effect_id or "",
            fact.message,
        ),
    )
