"""Pure deterministic Canon fix proposals over one immutable project document."""

from __future__ import annotations

from copy import deepcopy
import re

from ..project_document.patch import derive_project_patch
from ..schemas.canon_check import CanonIssueMetadataV1, CanonIssueMetadataV2, CanonOwnerRef
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.project_patch import ProjectPatch

_BARE_FLAG = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
_SINGLE_MEMBER_ENTRY_FACTS = frozenset({
    "flow.missing_entry",
    "flow.composable_flow_missing_entry",
    "playback.missing_entry",
})


class CanonFixerRegistry:
    """Dispatches only fixers whose forward change is unambiguous and reviewable."""

    def propose(
        self,
        metadata: CanonIssueMetadataV1,
        document: ProjectDocument,
    ) -> ProjectPatch | None:
        if metadata.rule_id == "condition.unresolved-path":
            expression = metadata.message_parameters.get("condition")
            if not isinstance(expression, str) or _BARE_FLAG.fullmatch(expression) is None:
                return None
            owner = metadata.scope or metadata.targets[0]
            target = _replace_condition(
                document,
                owner,
                expected=expression,
                replacement=f"flags.{expression} == true",
            )
        elif metadata.rule_id == "outcome.required-reachability":
            target = _add_required_outcome_route(document, metadata)
        elif (
            isinstance(metadata, CanonIssueMetadataV2)
            and metadata.rule_id == "integrity.error-fact"
            and metadata.diagnostic.fact_code in _SINGLE_MEMBER_ENTRY_FACTS
        ):
            target = _set_single_member_flow_entry(document, metadata)
        else:
            return None
        if target is None:
            return None
        patch = derive_project_patch(document, target)
        return patch if patch.operations else None


def _add_required_outcome_route(
    document: ProjectDocument,
    metadata: CanonIssueMetadataV1,
) -> ProjectDocument | None:
    """Add a conservative temporary route when one owning flow is unambiguous."""

    edge_id = metadata.message_parameters.get("edge_id")
    if not isinstance(edge_id, str):
        return None
    edge = next((item for item in document.edges if item.id == edge_id), None)
    if edge is None:
        return None
    flow_id = _outcome_flow_id(document, edge.source_node_id, edge.target_node_id)
    if flow_id is None:
        return None
    transition_id = f"canon-outcome-route-{edge.id}"
    if any(item.id == transition_id for item in document.flow_transitions):
        return None
    payload = document.model_dump(mode="python", exclude={"checksum"})
    outgoing_priorities = [
        item.priority
        for item in document.flow_transitions
        if item.flow_id == flow_id and item.source_node_id == edge.source_node_id
    ]
    origin_metadata = {
        key: value
        for key, value in edge.metadata.items()
        if key in {"dialogue_element_id", "quest_stage_id", "quest_branch_id"}
    }
    payload["flow_transitions"].append({
        "id": transition_id,
        "created_at": edge.updated_at,
        "updated_at": edge.updated_at,
        "project_id": edge.project_id,
        "flow_id": flow_id,
        "source_node_id": edge.source_node_id,
        "target_node_id": edge.target_node_id,
        "priority": max(outgoing_priorities, default=-1) + 1,
        "kind": "optional",
        "label": edge.label or "Temporary outcome route",
        "condition": _outcome_condition(document, edge.id),
        "is_default": False,
        "metadata": {
            "semantic_edge_id": edge.id,
            **origin_metadata,
            "canon_temporary": True,
        },
    })
    payload["flow_transitions"].sort(key=lambda item: item["id"])
    return create_project_document(**deepcopy(payload))


def _outcome_flow_id(
    document: ProjectDocument,
    source_node_id: str,
    target_node_id: str,
) -> str | None:
    """Prefer the single common flow entered through the outcome source node."""

    source_flows = {
        item.flow_id for item in document.story_flow_nodes if item.node_id == source_node_id
    }
    target_flows = {
        item.flow_id for item in document.story_flow_nodes if item.node_id == target_node_id
    }
    common = source_flows & target_flows
    entry_matches = [
        flow.id
        for flow in document.story_flows
        if flow.id in common and flow.entry_node_id == source_node_id
    ]
    if len(entry_matches) == 1:
        return entry_matches[0]
    return next(iter(common)) if len(common) == 1 else None


def _outcome_condition(document: ProjectDocument, edge_id: str) -> str:
    """Reuse the specialized authored condition when creating a temporary route."""

    edge = next(item for item in document.edges if item.id == edge_id)
    if edge.condition:
        return edge.condition
    branch_id = edge.metadata.get("quest_branch_id")
    stage_id = edge.metadata.get("quest_stage_id")
    if isinstance(branch_id, str) and isinstance(stage_id, str):
        for owned in document.quests:
            if owned.node_id != edge.source_node_id:
                continue
            for stage in owned.document.stages:
                if stage.id == stage_id:
                    branch = next((item for item in stage.branches if item.id == branch_id), None)
                    return branch.condition if branch is not None else ""
    dialogue_element_id = edge.metadata.get("dialogue_element_id")
    if isinstance(dialogue_element_id, str):
        for owned in document.dialogues:
            if owned.node_id != edge.source_node_id:
                continue
            for element in owned.document.elements:
                if element.kind == "choice":
                    option = next(
                        (item for item in element.options if item.id == dialogue_element_id),
                        None,
                    )
                    if option is not None:
                        return option.condition
    return ""


def _replace_condition(
    document: ProjectDocument,
    owner: CanonOwnerRef,
    *,
    expected: str,
    replacement: str,
) -> ProjectDocument | None:
    """Replace one unchanged condition while retaining every stable id and list order."""

    payload = document.model_dump(mode="python", exclude={"checksum"})
    direct_collections = {
        "edge": "edges",
        "flow_transition": "flow_transitions",
        "flow_invocation": "flow_invocations",
    }
    collection = direct_collections.get(owner.owner_type)
    changed = False
    if collection is not None:
        for record in payload[collection]:
            if record["id"] == owner.owner_id and record.get("condition", "") == expected:
                record["condition"] = replacement
                changed = True
                break
    elif owner.owner_type == "dialogue_option":
        changed = _replace_nested_condition(
            payload["dialogues"], "elements", "options", owner.owner_id, expected, replacement
        )
    elif owner.owner_type == "quest_branch":
        changed = _replace_nested_condition(
            payload["quests"], "stages", "branches", owner.owner_id, expected, replacement
        )
    if not changed:
        return None
    return create_project_document(**deepcopy(payload))


def _replace_nested_condition(
    owned_documents: list[dict[str, object]],
    parent_key: str,
    child_key: str,
    owner_id: str,
    expected: str,
    replacement: str,
) -> bool:
    for owned in owned_documents:
        document = owned.get("document")
        if not isinstance(document, dict):
            continue
        parents = document.get(parent_key, [])
        if not isinstance(parents, list):
            continue
        for parent in parents:
            if not isinstance(parent, dict):
                continue
            children = parent.get(child_key, [])
            if not isinstance(children, list):
                continue
            for child in children:
                if (
                    isinstance(child, dict)
                    and child.get("id") == owner_id
                    and child.get("condition", "") == expected
                ):
                    child["condition"] = replacement
                    return True
    return False


def _set_single_member_flow_entry(
    document: ProjectDocument,
    metadata: CanonIssueMetadataV2,
) -> ProjectDocument | None:
    """Set the only possible entry and reject every flow that requires a choice."""

    flow_ids = {
        owner.owner_id
        for owner in (metadata.scope, *metadata.targets)
        if owner is not None and owner.owner_type == "flow"
    }
    if len(flow_ids) != 1:
        return None
    flow_id = next(iter(flow_ids))
    flow = next((item for item in document.story_flows if item.id == flow_id), None)
    members = [item for item in document.story_flow_nodes if item.flow_id == flow_id]
    if flow is None or flow.entry_node_id is not None or len(members) != 1:
        return None
    member = members[0]
    if not any(node.id == member.node_id for node in document.nodes):
        return None

    payload = document.model_dump(mode="python", exclude={"checksum"})
    for record in payload["story_flows"]:
        if record["id"] == flow_id:
            record["entry_node_id"] = member.node_id
            break
    return create_project_document(**deepcopy(payload))
