from collections.abc import Mapping, Sequence
from typing import Any

from ..domain.entities import EdgeEntity, NodeEntity
from ..repositories.interfaces import UnitOfWork
from ..schemas.dialogue_integrity import DialogueIntegrityFact, DialogueIntegrityReport, DialogueTopologyCycle
from .service import DIALOGUE_METADATA_KEY, DialogueServiceError
from .transition_service import DIALOGUE_ORIGIN_METADATA_KEY


class DialogueIntegrityService:
    """Reads stored dialogue topology and reports facts without mutating it."""

    def inspect(self, uow: UnitOfWork, node_id: str) -> DialogueIntegrityReport:
        dialogue = uow.nodes.get(node_id)
        if dialogue is None:
            raise DialogueServiceError("dialogue_node_not_found", f"Dialogue node not found: {node_id}")
        if dialogue.type != "Dialogue":
            raise DialogueServiceError("node_is_not_dialogue", f"Node is not a Dialogue node: {node_id}")

        stored = dialogue.metadata.get(DIALOGUE_METADATA_KEY, {})
        if not isinstance(stored, dict):
            raise DialogueServiceError(
                "dialogue_stored_document_invalid",
                f"Stored dialogue document is invalid: {node_id}",
            )
        participants = _string_list(stored.get("participants"))
        participant_nodes = {participant_id: uow.nodes.get(participant_id) for participant_id in participants}
        edges = [edge for edge in uow.edges.list(project_id=dialogue.project_id) if edge.source_node_id == dialogue.id]
        return analyze_dialogue_integrity(dialogue, stored, participant_nodes, edges)


def analyze_dialogue_integrity(
    dialogue: NodeEntity,
    stored: Mapping[str, Any],
    participant_nodes: Mapping[str, NodeEntity | None],
    edges: Sequence[EdgeEntity],
) -> DialogueIntegrityReport:
    """Produces stable facts from permissive stored data, including legacy corruption."""
    facts: list[DialogueIntegrityFact] = []
    participants = _string_list(stored.get("participants"))
    elements = [value for value in _object_list(stored.get("elements")) if isinstance(value.get("id"), str)]
    element_ids = [str(element["id"]) for element in elements]
    element_id_set = set(element_ids)
    element_order = {element_id: index for index, element_id in enumerate(element_ids)}

    for participant_id in participants:
        participant = participant_nodes.get(participant_id)
        if participant is None or participant.project_id != dialogue.project_id or participant.type != "Character":
            facts.append(
                DialogueIntegrityFact(
                    code="missing_participant",
                    reference_id=participant_id,
                    message=f"Participant '{participant_id}' is not an available Character in this project.",
                    action="Replace the participant reference or restore the missing Character node.",
                )
            )

    origins, adjacency = _dialogue_origins_and_adjacency(elements)
    external_origins: set[str] = set()
    for edge in sorted(edges, key=lambda candidate: candidate.id):
        if DIALOGUE_ORIGIN_METADATA_KEY not in edge.metadata:
            continue
        origin = edge.metadata.get(DIALOGUE_ORIGIN_METADATA_KEY)
        if isinstance(origin, str) and origin in origins:
            external_origins.add(origin)
            continue
        facts.append(
            DialogueIntegrityFact(
                code="stale_external_transition_origin",
                edge_id=edge.id,
                reference_id=origin if isinstance(origin, str) else None,
                message=f"Transition '{edge.id}' points to a dialogue origin that no longer exists.",
                action="Reassign the transition to an existing line or answer, or delete the transition.",
            )
        )

    entry_id = stored.get("entry_element_id")
    if isinstance(entry_id, str) and entry_id not in element_id_set:
        facts.append(_broken_reference(None, entry_id, "entry element"))

    participant_set = set(participants)
    for element in elements:
        element_id = str(element["id"])
        if element.get("kind") == "line":
            speaker_id = element.get("speaker_node_id")
            if isinstance(speaker_id, str) and speaker_id not in participant_set:
                facts.append(_broken_reference(element_id, speaker_id, "speaker participant"))
            _append_next_reference_fact(facts, element_id, element.get("next_element_id"), element_id_set)
            if element.get("next_element_id") is None and element_id not in external_origins:
                facts.append(_dead_end(element_id, "line"))
            continue

        options = _object_list(element.get("options"))
        if not options:
            facts.append(_dead_end(element_id, "choice"))
        for option in options:
            option_id = option.get("id")
            if not isinstance(option_id, str):
                continue
            _append_next_reference_fact(facts, option_id, option.get("next_element_id"), element_id_set)
            if option.get("next_element_id") is None and option_id not in external_origins:
                facts.append(_dead_end(option_id, "answer"))

    reachable = _reachable_elements(entry_id if isinstance(entry_id, str) else None, adjacency, element_id_set)
    for element_id in element_ids:
        if element_id not in reachable:
            facts.append(
                DialogueIntegrityFact(
                    code="unreachable_element",
                    element_id=element_id,
                    message=f"Dialogue element '{element_id}' cannot be reached from the entry element.",
                    action="Connect an existing branch to this element or remove it.",
                )
            )

    cycles = [
        DialogueTopologyCycle(
            element_ids=cycle,
            message=f"Valid dialogue cycle connects: {', '.join(cycle)}.",
        )
        for cycle in _topology_cycles(element_ids, adjacency, element_order)
    ]
    return DialogueIntegrityReport(dialogue_node_id=dialogue.id, facts=facts, cycles=cycles)


def _string_list(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _object_list(value: object) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _dialogue_origins_and_adjacency(elements: Sequence[Mapping[str, Any]]) -> tuple[set[str], dict[str, list[str]]]:
    origins: set[str] = set()
    adjacency: dict[str, list[str]] = {}
    for element in elements:
        element_id = str(element["id"])
        adjacency[element_id] = []
        if element.get("kind") == "line":
            origins.add(element_id)
            next_id = element.get("next_element_id")
            if isinstance(next_id, str):
                adjacency[element_id].append(next_id)
            continue
        for option in _object_list(element.get("options")):
            option_id = option.get("id")
            if isinstance(option_id, str):
                origins.add(option_id)
            next_id = option.get("next_element_id")
            if isinstance(next_id, str):
                adjacency[element_id].append(next_id)
    return origins, adjacency


def _broken_reference(element_id: str | None, reference_id: str, role: str) -> DialogueIntegrityFact:
    return DialogueIntegrityFact(
        code="broken_reference",
        element_id=element_id,
        reference_id=reference_id,
        message=f"The {role} reference '{reference_id}' does not exist in this dialogue.",
        action="Select an existing dialogue element or clear the reference as an intentional ending.",
    )


def _append_next_reference_fact(
    facts: list[DialogueIntegrityFact], owner_id: str, next_id: object, element_ids: set[str]
) -> None:
    if isinstance(next_id, str) and next_id not in element_ids:
        facts.append(_broken_reference(owner_id, next_id, "next element"))


def _dead_end(element_id: str, kind: str) -> DialogueIntegrityFact:
    return DialogueIntegrityFact(
        code="dead_end",
        element_id=element_id,
        message=f"The {kind} '{element_id}' has no internal or external continuation.",
        action="Confirm it as an intentional ending or connect it to another dialogue element or narrative node.",
    )


def _reachable_elements(
    entry_id: str | None,
    adjacency: Mapping[str, Sequence[str]],
    element_ids: set[str],
) -> set[str]:
    if entry_id not in element_ids:
        return set()
    reachable: set[str] = set()
    pending = [entry_id]
    while pending:
        element_id = pending.pop()
        if element_id in reachable:
            continue
        reachable.add(element_id)
        pending.extend(next_id for next_id in adjacency.get(element_id, []) if next_id in element_ids)
    return reachable


def _topology_cycles(
    element_ids: Sequence[str], adjacency: Mapping[str, Sequence[str]], element_order: Mapping[str, int]
) -> list[list[str]]:
    # Tarjan components provide one deterministic cycle record per authored loop,
    # including self-loops, without classifying valid cyclic topology as a fact.
    index = 0
    indexes: dict[str, int] = {}
    low_links: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    components: list[list[str]] = []

    def visit(element_id: str) -> None:
        nonlocal index
        indexes[element_id] = index
        low_links[element_id] = index
        index += 1
        stack.append(element_id)
        on_stack.add(element_id)

        for next_id in adjacency.get(element_id, []):
            if next_id not in element_order:
                continue
            if next_id not in indexes:
                visit(next_id)
                low_links[element_id] = min(low_links[element_id], low_links[next_id])
            elif next_id in on_stack:
                low_links[element_id] = min(low_links[element_id], indexes[next_id])

        if low_links[element_id] != indexes[element_id]:
            return
        component: list[str] = []
        while stack:
            member = stack.pop()
            on_stack.remove(member)
            component.append(member)
            if member == element_id:
                break
        component.sort(key=element_order.__getitem__)
        if len(component) > 1 or element_id in adjacency.get(element_id, []):
            components.append(component)

    for element_id in element_ids:
        if element_id not in indexes:
            visit(element_id)
    components.sort(key=lambda component: element_order[component[0]])
    return components
