from collections import Counter, defaultdict, deque
from collections.abc import Sequence

from ..domain.entities import (
    EdgeEntity,
    FlowTransitionEntity,
    NodeEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    VisualPlacementEntity,
)
from ..repositories.interfaces import UnitOfWork
from ..schemas.composition import LOCATION_CHILD_KINDS, SCENE_CHILD_KINDS
from ..schemas.story_flow import FlowIntegrityFact, StoryFlowIntegrityReport
from .service import StoryFlowServiceError


class StoryFlowIntegrityService:
    """Reads one flow plus project composition without creating Issue records."""

    def inspect(self, uow: UnitOfWork, flow_id: str) -> StoryFlowIntegrityReport:
        flow = uow.story_flows.get(flow_id)
        if flow is None:
            raise StoryFlowServiceError("story_flow_not_found", f"Story Flow not found: {flow_id}")
        project = uow.projects.get(flow.project_id)
        if project is None:
            raise StoryFlowServiceError(
                "story_flow_project_not_found",
                f"Project not found: {flow.project_id}",
            )
        return analyze_authoring_integrity(
            flow,
            uow.nodes.list(project_id=flow.project_id),
            uow.story_flow_nodes.list(project_id=flow.project_id, flow_id=flow.id),
            uow.flow_transitions.list(project_id=flow.project_id, flow_id=flow.id),
            uow.scene_flow_boundaries.list(project_id=flow.project_id, flow_id=flow.id),
            uow.visual_placements.list(project_id=flow.project_id),
            uow.edges.list(project_id=flow.project_id),
        )


def analyze_authoring_integrity(
    flow: StoryFlowEntity,
    nodes: Sequence[NodeEntity],
    memberships: Sequence[StoryFlowNodeEntity],
    transitions: Sequence[FlowTransitionEntity],
    boundaries: Sequence[SceneFlowBoundaryEntity],
    placements: Sequence[VisualPlacementEntity],
    relationships: Sequence[EdgeEntity],
) -> StoryFlowIntegrityReport:
    """Produces deterministic facts from permissive records, including imported corruption."""

    facts: list[FlowIntegrityFact] = []
    nodes_by_id = {node.id: node for node in nodes}
    member_ids = {membership.node_id for membership in memberships}

    _inspect_flow_records(facts, flow, nodes_by_id, memberships, transitions)
    valid_transitions = [
        transition
        for transition in transitions
        if transition.project_id == flow.project_id
        and transition.flow_id == flow.id
        and transition.source_node_id in member_ids
        and transition.target_node_id in member_ids
        and transition.source_node_id in nodes_by_id
        and transition.target_node_id in nodes_by_id
        and nodes_by_id[transition.source_node_id].project_id == flow.project_id
        and nodes_by_id[transition.target_node_id].project_id == flow.project_id
    ]
    reachable = _reachable(flow.entry_node_id, member_ids, valid_transitions)
    _inspect_reachability(facts, flow, memberships, valid_transitions, reachable)
    _inspect_boundaries(facts, flow, nodes_by_id, member_ids, boundaries, placements)
    _inspect_composition(facts, flow, nodes_by_id, placements, relationships)

    return StoryFlowIntegrityReport(
        project_id=flow.project_id,
        flow_id=flow.id,
        facts=sorted(facts, key=_fact_sort_key),
    )


def _inspect_flow_records(
    facts: list[FlowIntegrityFact],
    flow: StoryFlowEntity,
    nodes: dict[str, NodeEntity],
    memberships: Sequence[StoryFlowNodeEntity],
    transitions: Sequence[FlowTransitionEntity],
) -> None:
    member_ids = {membership.node_id for membership in memberships}
    if flow.entry_node_id is None:
        facts.append(_fact("missing_entry", "error", "This Story Flow has no entry.", "Choose one flow member as the entry.", flow_id=flow.id))
    elif (
        flow.entry_node_id not in member_ids
        or flow.entry_node_id not in nodes
        or nodes[flow.entry_node_id].project_id != flow.project_id
    ):
        facts.append(
            _fact(
                "invalid_entry",
                "error",
                f"Entry '{flow.entry_node_id}' is missing or outside this Story Flow.",
                "Choose an existing member as the entry.",
                flow_id=flow.id,
                node_id=flow.entry_node_id,
            )
        )

    membership_counts = Counter(membership.node_id for membership in memberships)
    for membership in sorted(memberships, key=lambda item: item.id):
        if membership.project_id != flow.project_id or membership.flow_id != flow.id:
            facts.append(_cross_project(flow.id, membership.node_id, f"Membership '{membership.id}'"))
        if membership.node_id not in nodes or nodes[membership.node_id].project_id != flow.project_id:
            facts.append(_cross_project(flow.id, membership.node_id, f"Membership '{membership.id}'"))
        if membership_counts[membership.node_id] > 1:
            facts.append(
                _fact(
                    "duplicate_membership",
                    "error",
                    f"Node '{membership.node_id}' is included more than once.",
                    "Keep one membership for this node.",
                    flow_id=flow.id,
                    node_id=membership.node_id,
                )
            )
            membership_counts[membership.node_id] = 0

    priority_counts = Counter((item.source_node_id, item.priority) for item in transitions)
    default_counts = Counter(item.source_node_id for item in transitions if item.is_default)
    for transition in sorted(transitions, key=lambda item: item.id):
        if transition.project_id != flow.project_id or transition.flow_id != flow.id:
            facts.append(
                _fact(
                    "cross_project_reference",
                    "error",
                    f"Transition '{transition.id}' belongs to another project or flow.",
                    "Move or recreate the transition in this Story Flow.",
                    flow_id=flow.id,
                    transition_id=transition.id,
                )
            )
        endpoints = (nodes.get(transition.source_node_id), nodes.get(transition.target_node_id))
        if (
            transition.source_node_id not in member_ids
            or transition.target_node_id not in member_ids
            or any(node is None or node.project_id != flow.project_id for node in endpoints)
        ):
            facts.append(
                _fact(
                    "dangling_transition_endpoint",
                    "error",
                    f"Transition '{transition.id}' has an endpoint outside flow membership.",
                    "Add both endpoints to the flow or remove the transition.",
                    flow_id=flow.id,
                    node_id=transition.source_node_id,
                    transition_id=transition.id,
                )
            )
        if priority_counts[(transition.source_node_id, transition.priority)] > 1:
            facts.append(
                _fact(
                    "duplicate_transition_priority",
                    "error",
                    f"Source '{transition.source_node_id}' uses priority {transition.priority} more than once.",
                    "Reorder outgoing transitions so every priority is unique.",
                    flow_id=flow.id,
                    node_id=transition.source_node_id,
                    transition_id=transition.id,
                )
            )
        if default_counts[transition.source_node_id] > 1 and transition.is_default:
            facts.append(
                _fact(
                    "multiple_default_branches",
                    "error",
                    f"Source '{transition.source_node_id}' has multiple default branches.",
                    "Keep exactly one default branch.",
                    flow_id=flow.id,
                    node_id=transition.source_node_id,
                    transition_id=transition.id,
                )
            )
        if transition.is_default and transition.condition.strip():
            facts.append(
                _fact(
                    "conditioned_default_branch",
                    "error",
                    f"Default transition '{transition.id}' also has a condition.",
                    "Remove the condition or stop marking the transition as default.",
                    flow_id=flow.id,
                    transition_id=transition.id,
                )
            )
        if transition.kind == "branch" and not transition.is_default and not transition.condition.strip():
            facts.append(
                _fact(
                    "branch_without_condition",
                    "error",
                    f"Branch transition '{transition.id}' has no condition.",
                    "Add a condition or make it the default branch.",
                    flow_id=flow.id,
                    transition_id=transition.id,
                )
            )


def _inspect_reachability(
    facts: list[FlowIntegrityFact],
    flow: StoryFlowEntity,
    memberships: Sequence[StoryFlowNodeEntity],
    transitions: Sequence[FlowTransitionEntity],
    reachable: set[str],
) -> None:
    outgoing = Counter(transition.source_node_id for transition in transitions)
    for node_id in sorted({membership.node_id for membership in memberships}):
        if flow.entry_node_id is not None and node_id not in reachable:
            facts.append(
                _fact(
                    "unreachable_member",
                    "warning",
                    f"Flow member '{node_id}' cannot be reached from the entry.",
                    "Connect it to the route or remove it from this Story Flow.",
                    flow_id=flow.id,
                    node_id=node_id,
                )
            )
        if node_id in reachable and outgoing[node_id] == 0:
            facts.append(
                _fact(
                    "ending",
                    "info",
                    f"Node '{node_id}' is an ending.",
                    "Keep it as an ending or add a continuation.",
                    flow_id=flow.id,
                    node_id=node_id,
                )
            )
    if memberships and reachable and not any(outgoing[node_id] == 0 for node_id in reachable):
        facts.append(
            _fact(
                "no_ending",
                "warning",
                "This Story Flow has no reachable ending.",
                "Confirm the loop is intentional or add an ending.",
                flow_id=flow.id,
            )
        )
    for component in _cyclic_components(reachable, transitions):
        owner = component[0]
        facts.append(
            _fact(
                "cycle",
                "info",
                f"Intentional cycle candidate: {' -> '.join(component)}.",
                "Keep the loop if intentional; otherwise change a transition.",
                flow_id=flow.id,
                node_id=owner,
            )
        )


def _inspect_boundaries(
    facts: list[FlowIntegrityFact],
    flow: StoryFlowEntity,
    nodes: dict[str, NodeEntity],
    member_ids: set[str],
    boundaries: Sequence[SceneFlowBoundaryEntity],
    placements: Sequence[VisualPlacementEntity],
) -> None:
    children = defaultdict(set)
    for placement in placements:
        if placement.container_node_id is not None:
            children[placement.container_node_id].add(placement.canonical_node_id)
    for boundary in sorted(boundaries, key=lambda item: item.id):
        refs = [boundary.entry_node_id, *boundary.exit_node_ids]
        invalid = (
            boundary.project_id != flow.project_id
            or boundary.flow_id != flow.id
            or nodes.get(boundary.scene_node_id) is None
            or nodes.get(boundary.scene_node_id).type != "Scene"
            or boundary.scene_node_id not in member_ids
            or boundary.scene_node_id in refs
            or len(boundary.exit_node_ids) != len(set(boundary.exit_node_ids))
            or any(reference not in member_ids or reference not in children[boundary.scene_node_id] for reference in refs)
        )
        if invalid:
            facts.append(
                _fact(
                    "invalid_scene_boundary",
                    "error",
                    f"Scene boundary '{boundary.id}' references an invalid owner, entry, or exit.",
                    "Choose unique flow members placed directly inside this Scene.",
                    flow_id=flow.id,
                    scene_node_id=boundary.scene_node_id,
                )
            )


def _inspect_composition(
    facts: list[FlowIntegrityFact],
    flow: StoryFlowEntity,
    nodes: dict[str, NodeEntity],
    placements: Sequence[VisualPlacementEntity],
    relationships: Sequence[EdgeEntity],
) -> None:
    scope_counts = Counter((item.container_node_id, item.canonical_node_id) for item in placements)
    placement_pairs: set[tuple[str, str]] = set()
    for placement in sorted(placements, key=lambda item: item.id):
        node = nodes.get(placement.canonical_node_id)
        container = nodes.get(placement.container_node_id) if placement.container_node_id else None
        if placement.project_id != flow.project_id:
            facts.append(
                _fact(
                    "dangling_placement",
                    "error",
                    f"Placement '{placement.id}' belongs to another project.",
                    "Move or recreate the placement in this project.",
                    flow_id=flow.id,
                    placement_id=placement.id,
                )
            )
        if node is None:
            facts.append(
                _fact(
                    "missing_canonical_node",
                    "error",
                    f"Placement '{placement.id}' has no canonical node.",
                    "Restore the canonical node or delete the placement.",
                    flow_id=flow.id,
                    placement_id=placement.id,
                )
            )
        if placement.container_node_id is not None and container is None:
            facts.append(
                _fact(
                    "dangling_placement",
                    "error",
                    f"Placement '{placement.id}' has no container.",
                    "Move it to the root canvas or restore its container.",
                    flow_id=flow.id,
                    placement_id=placement.id,
                )
            )
        if node is not None and container is not None and not _allows_child(container.type, node.type):
            facts.append(
                _fact(
                    "invalid_child_kind",
                    "error",
                    f"{node.type} '{node.id}' cannot be placed inside {container.type} '{container.id}'.",
                    "Move the node to a compatible container or the root canvas.",
                    flow_id=flow.id,
                    node_id=node.id,
                    container_node_id=container.id,
                    placement_id=placement.id,
                )
            )
        if scope_counts[(placement.container_node_id, placement.canonical_node_id)] > 1:
            facts.append(
                _fact(
                    "duplicate_placement",
                    "error",
                    f"Node '{placement.canonical_node_id}' is placed more than once in the same scope.",
                    "Keep one placement in this container; reuse in another container remains valid.",
                    flow_id=flow.id,
                    node_id=placement.canonical_node_id,
                    container_node_id=placement.container_node_id,
                    placement_id=placement.id,
                )
            )
        if placement.container_node_id is not None:
            placement_pairs.add((placement.container_node_id, placement.canonical_node_id))

    for component in _containment_cycles(placements):
        facts.append(
            _fact(
                "containment_cycle",
                "error",
                f"Composition containment forms a cycle through {' -> '.join(component)}.",
                "Move one placement outside the cycle.",
                flow_id=flow.id,
                node_id=component[0],
            )
        )

    contains_edges = [edge for edge in relationships if edge.type == "contains"]
    edge_pairs = {(edge.source_node_id, edge.target_node_id) for edge in contains_edges}
    for edge in sorted(contains_edges, key=lambda item: item.id):
        if edge.project_id != flow.project_id or (edge.source_node_id, edge.target_node_id) not in placement_pairs:
            facts.append(
                _fact(
                    "stale_membership",
                    "warning",
                    f"Contains relationship '{edge.id}' has no matching placement.",
                    "Reconcile the relationship with the visual composition.",
                    flow_id=flow.id,
                    node_id=edge.target_node_id,
                    container_node_id=edge.source_node_id,
                    relationship_id=edge.id,
                )
            )
    for placement in sorted(placements, key=lambda item: item.id):
        pair = (placement.container_node_id, placement.canonical_node_id)
        if placement.container_node_id is not None and pair not in edge_pairs:
            facts.append(
                _fact(
                    "stale_membership",
                    "warning",
                    f"Placement '{placement.id}' has no matching contains relationship.",
                    "Reconcile the visual placement with semantic composition.",
                    flow_id=flow.id,
                    node_id=placement.canonical_node_id,
                    container_node_id=placement.container_node_id,
                    placement_id=placement.id,
                )
            )


def _reachable(
    entry_node_id: str | None,
    member_ids: set[str],
    transitions: Sequence[FlowTransitionEntity],
) -> set[str]:
    adjacency: dict[str, list[str]] = defaultdict(list)
    for transition in transitions:
        adjacency[transition.source_node_id].append(transition.target_node_id)
    reached: set[str] = set()
    pending = deque([entry_node_id] if entry_node_id in member_ids else [])
    while pending:
        node_id = pending.popleft()
        if node_id in reached:
            continue
        reached.add(node_id)
        pending.extend(sorted(adjacency[node_id]))
    return reached


def _cyclic_components(
    node_ids: set[str],
    transitions: Sequence[FlowTransitionEntity],
) -> list[list[str]]:
    adjacency: dict[str, set[str]] = defaultdict(set)
    for transition in transitions:
        if transition.source_node_id in node_ids and transition.target_node_id in node_ids:
            adjacency[transition.source_node_id].add(transition.target_node_id)
    return _strongly_connected_components(node_ids, adjacency)


def _containment_cycles(placements: Sequence[VisualPlacementEntity]) -> list[list[str]]:
    node_ids: set[str] = set()
    adjacency: dict[str, set[str]] = defaultdict(set)
    for placement in placements:
        if placement.container_node_id is None:
            continue
        node_ids.update((placement.container_node_id, placement.canonical_node_id))
        adjacency[placement.container_node_id].add(placement.canonical_node_id)
    return _strongly_connected_components(node_ids, adjacency)


def _strongly_connected_components(
    node_ids: set[str],
    adjacency: dict[str, set[str]],
) -> list[list[str]]:
    """Returns stable cyclic SCCs using a compact Tarjan traversal."""

    index = 0
    indices: dict[str, int] = {}
    low_links: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    components: list[list[str]] = []

    def visit(node_id: str) -> None:
        nonlocal index
        indices[node_id] = index
        low_links[node_id] = index
        index += 1
        stack.append(node_id)
        on_stack.add(node_id)
        for target_id in sorted(adjacency[node_id]):
            if target_id not in indices:
                visit(target_id)
                low_links[node_id] = min(low_links[node_id], low_links[target_id])
            elif target_id in on_stack:
                low_links[node_id] = min(low_links[node_id], indices[target_id])
        if low_links[node_id] != indices[node_id]:
            return
        component: list[str] = []
        while stack:
            current = stack.pop()
            on_stack.remove(current)
            component.append(current)
            if current == node_id:
                break
        ordered = sorted(component)
        if len(ordered) > 1 or (ordered and ordered[0] in adjacency[ordered[0]]):
            components.append(ordered)

    for node_id in sorted(node_ids):
        if node_id not in indices:
            visit(node_id)
    return sorted(components)


def _allows_child(container_kind: str, child_kind: str) -> bool:
    if container_kind == "Scene":
        return child_kind in SCENE_CHILD_KINDS
    if container_kind == "Location":
        return child_kind in LOCATION_CHILD_KINDS
    return False


def _cross_project(flow_id: str, node_id: str, owner: str) -> FlowIntegrityFact:
    return _fact(
        "cross_project_reference",
        "error",
        f"{owner} references a node outside this project.",
        "Replace the reference with a node from this project.",
        flow_id=flow_id,
        node_id=node_id,
    )


def _fact(code: str, level: str, message: str, action: str, **owners: str | None) -> FlowIntegrityFact:
    return FlowIntegrityFact(code=code, level=level, message=message, action=action, **owners)


def _fact_sort_key(fact: FlowIntegrityFact) -> tuple[str, ...]:
    return (
        {"error": "0", "warning": "1", "info": "2"}[fact.level],
        fact.code,
        fact.flow_id or "",
        fact.scene_node_id or "",
        fact.container_node_id or "",
        fact.node_id or "",
        fact.transition_id or "",
        fact.placement_id or "",
        fact.relationship_id or "",
        fact.message,
    )
