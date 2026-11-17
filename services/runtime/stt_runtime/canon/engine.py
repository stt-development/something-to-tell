"""Pure deterministic canon rules over one immutable saved-revision input."""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol

from ..playback.condition_evaluator import LarkConditionEvaluator
from ..project_format.manifest import CanonCheckSettings
from ..schemas.canon_check import (
    CanonCheckInput,
    CanonDiagnosticV1,
    CanonDomain,
    CanonEvidenceRef,
    CanonFact,
    CanonIssueCandidate,
    CanonIssueSeverity,
    CanonOwnerRef,
    CanonRuleDescriptor,
    canon_issue_fingerprint,
)
from ..schemas.playback import PlaybackState
from ..schemas.project_document import (
    ProjectDocument,
    ProjectEdgeRecord,
    ProjectFlowExitRecord,
    ProjectFlowInitialStateRecord,
    ProjectFlowTransitionRecord,
)
from .diagnostics import normalize_integrity_fact
from .registry import CanonRuleRegistry

CANON_RULE_PACK_VERSION = 1


class CanonRule(Protocol):
    """Executable storage-free rule contract used by the deterministic engine."""

    descriptor: CanonRuleDescriptor

    def evaluate(
        self,
        check_input: CanonCheckInput,
        facts: tuple[CanonFact, ...],
        *,
        severity: CanonIssueSeverity,
    ) -> tuple[CanonIssueCandidate, ...]: ...


class CanonRuleEngineError(ValueError):
    """Stable rule-pack failure for the later run coordinator."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class CanonRulePack:
    """Versioned immutable executable rule collection."""

    version: int
    rules: tuple[CanonRule, ...]


@dataclass(frozen=True)
class _Finding:
    """Rule-local result converted centrally into a strict candidate contract."""

    scope: CanonOwnerRef
    targets: tuple[CanonOwnerRef, ...]
    evidence: tuple[CanonEvidenceRef, ...]
    message_parameters: dict[str, object]
    recommendation_parameters: dict[str, object]
    diagnostic: CanonDiagnosticV1 | None = None
    message_key: str | None = None
    recommendation_key: str | None = None


FindingEvaluator = Callable[[CanonCheckInput, tuple[CanonFact, ...]], Iterable[_Finding]]


@dataclass(frozen=True)
class _FunctionalRule:
    descriptor: CanonRuleDescriptor
    evaluator: FindingEvaluator

    def evaluate(
        self,
        check_input: CanonCheckInput,
        facts: tuple[CanonFact, ...],
        *,
        severity: CanonIssueSeverity,
    ) -> tuple[CanonIssueCandidate, ...]:
        candidates = [
            _candidate(self.descriptor, severity, finding)
            for finding in self.evaluator(check_input, facts)
        ]
        return tuple(sorted(candidates, key=_candidate_key))


class CanonRuleEngine:
    """Resolves project policy and executes pure rules in stable registry order."""

    def __init__(self, rule_pack: CanonRulePack | None = None) -> None:
        self.rule_pack = rule_pack or initial_canon_rule_pack()
        self._rules = {rule.descriptor.id: rule for rule in self.rule_pack.rules}
        self.registry = CanonRuleRegistry(rule.descriptor for rule in self.rule_pack.rules)

    def evaluate(
        self,
        check_input: CanonCheckInput,
        *,
        settings: CanonCheckSettings | None = None,
    ) -> tuple[CanonIssueCandidate, ...]:
        """Evaluate without repository, provider, clock, or caller-owned mutation."""

        if check_input.rule_pack_version != self.rule_pack.version:
            raise CanonRuleEngineError("canon_rule_pack_version_unsupported")
        policy = settings or check_input.document.manifest.settings.canon_check
        if not policy.deterministic_enabled:
            return ()

        candidates: list[CanonIssueCandidate] = []
        for resolved in self.registry.resolve(policy):
            rule = self._rules[resolved.descriptor.id]
            domains = set(resolved.descriptor.input_domains)
            relevant = tuple(fact for fact in check_input.facts if fact.domain in domains)
            candidates.extend(
                rule.evaluate(check_input, relevant, severity=resolved.severity)
            )
        return tuple(candidates)


def initial_canon_rule_pack() -> CanonRulePack:
    """Build the complete offline v1 pack in descriptor-id order."""

    rules = (
        _rule(
            "condition.unresolved-path",
            "conditions",
            "warning",
            ("dialogue", "flow", "quest", "temporal"),
            _unresolved_condition_findings,
        ),
        _rule(
            "flow.return-mapping",
            "flow",
            "critical",
            ("flow",),
            _missing_return_mapping_findings,
        ),
        _rule(
            "integrity.error-fact",
            "integrity",
            "critical",
            ("composition", "dialogue", "flow", "graph", "playback", "quest", "temporal"),
            _error_fact_findings,
        ),
        _rule(
            "outcome.required-reachability",
            "outcomes",
            "critical",
            ("dialogue", "flow", "graph", "quest"),
            _required_outcome_findings,
        ),
        _rule(
            "outcome.specialized-ownership",
            "outcomes",
            "critical",
            ("dialogue", "flow", "graph", "quest"),
            _specialized_ownership_findings,
        ),
        _rule(
            "ownership.custody-disagreement",
            "continuity",
            "warning",
            ("graph", "temporal"),
            _custody_disagreement_findings,
        ),
        _rule(
            "relationship.exclusive-conflict",
            "continuity",
            "critical",
            ("graph",),
            _exclusive_relationship_findings,
        ),
    )
    return CanonRulePack(version=CANON_RULE_PACK_VERSION, rules=rules)


def _rule(
    rule_id: str,
    category: str,
    severity: CanonIssueSeverity,
    domains: tuple[CanonDomain, ...],
    evaluator: FindingEvaluator,
) -> _FunctionalRule:
    return _FunctionalRule(
        descriptor=CanonRuleDescriptor(
            id=rule_id,
            version=1,
            category=category,
            default_severity=severity,
            input_domains=domains,
        ),
        evaluator=evaluator,
    )


def _candidate(
    descriptor: CanonRuleDescriptor,
    severity: CanonIssueSeverity,
    finding: _Finding,
) -> CanonIssueCandidate:
    targets = finding.targets or (finding.scope,)
    return CanonIssueCandidate(
        rule_id=descriptor.id,
        rule_version=descriptor.version,
        category=descriptor.category,
        severity=severity,
        scope=finding.scope,
        message_key=finding.message_key or f"canon.issue.{descriptor.id}.message",
        message_parameters=finding.message_parameters,
        recommendation_key=(
            finding.recommendation_key
            or f"canon.issue.{descriptor.id}.recommendation"
        ),
        recommendation_parameters=finding.recommendation_parameters,
        targets=targets,
        evidence=finding.evidence,
        diagnostic=finding.diagnostic,
        fingerprint=canon_issue_fingerprint(
            rule_id=descriptor.id,
            rule_version=descriptor.version,
            scope=finding.scope,
            targets=targets,
            diagnostic=finding.diagnostic,
        ),
    )


def _error_fact_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del check_input
    dedicated_codes = {
        "flow.composable_flow_unbound_exit",
        "dialogue.stale_external_transition_origin",
    }
    for fact in facts:
        if fact.level != "error" or fact.code in dedicated_codes:
            continue
        diagnostic, message_key, message_parameters, recommendation_key, recommendation_parameters = (
            normalize_integrity_fact(fact)
        )
        yield _Finding(
            scope=fact.scope,
            targets=diagnostic.targets,
            evidence=diagnostic.evidence,
            message_parameters=message_parameters,
            recommendation_parameters=recommendation_parameters,
            diagnostic=diagnostic,
            message_key=message_key,
            recommendation_key=recommendation_key,
        )


def _specialized_ownership_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del facts
    document = check_input.document
    for edge in document.edges:
        specialized = _is_specialized_edge(edge)
        pointer = edge.metadata.get("outcome_flow_composition")
        if not specialized and pointer is None:
            continue
        origin, reason = _specialized_origin(document, edge)
        direct = _direct_outcome_routes(document, edge)
        if reason is None:
            if len(direct) > 1 or (pointer is not None and direct):
                reason = "multiple_outcome_routes"
            elif direct and not _valid_direct_outcome(edge, direct[0]):
                reason = "stale_direct_route_owner"
            elif pointer is not None and not _valid_outcome_pointer(document, edge):
                reason = "stale_composition_pointer"
        if reason is None:
            continue
        edge_owner = _owner("edge", edge.id)
        targets = tuple([edge_owner, *([origin] if origin is not None else [])])
        yield _Finding(
            scope=edge_owner,
            targets=targets,
            evidence=(_evidence(edge_owner, "metadata", excerpt=edge.label),),
            message_parameters={"edge_id": edge.id, "reason": reason},
            recommendation_parameters={"edge_id": edge.id},
        )


def _required_outcome_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del facts
    document = check_input.document
    for edge in document.edges:
        if not _is_specialized_edge(edge):
            continue
        origin, reason = _specialized_origin(document, edge)
        if reason is not None:
            continue
        direct_valid = any(
            _valid_direct_outcome(edge, route)
            for route in _direct_outcome_routes(document, edge)
        )
        pointer_valid = _valid_outcome_pointer(document, edge, require_target=True)
        if direct_valid or pointer_valid:
            continue
        edge_owner = _owner("edge", edge.id)
        assert origin is not None
        yield _Finding(
            scope=origin,
            targets=(edge_owner, origin, _owner("node", edge.target_node_id)),
            evidence=(_evidence(edge_owner, "metadata", excerpt=edge.label),),
            message_parameters={"edge_id": edge.id, "target_node_id": edge.target_node_id},
            recommendation_parameters={"edge_id": edge.id},
        )


def _missing_return_mapping_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del facts
    document = check_input.document
    exits_by_flow: dict[str, list[ProjectFlowExitRecord]] = defaultdict(list)
    for flow_exit in document.flow_exits:
        exits_by_flow[flow_exit.flow_id].append(flow_exit)
    binding_pairs = {
        (binding.invocation_id, binding.exit_id) for binding in document.flow_exit_bindings
    }
    for invocation in document.flow_invocations:
        for flow_exit in exits_by_flow[invocation.target_flow_id]:
            if (invocation.id, flow_exit.id) in binding_pairs:
                continue
            invocation_owner = _owner("flow_invocation", invocation.id)
            exit_owner = _owner("flow_exit", flow_exit.id)
            yield _Finding(
                scope=invocation_owner,
                targets=(invocation_owner, exit_owner, _owner("flow", invocation.source_flow_id)),
                evidence=(
                    _evidence(invocation_owner, "target_flow_id", excerpt=invocation.label),
                    _evidence(exit_owner, "key", excerpt=flow_exit.label or flow_exit.key),
                ),
                message_parameters={
                    "invocation_id": invocation.id,
                    "exit_id": flow_exit.id,
                },
                recommendation_parameters={
                    "invocation_id": invocation.id,
                    "exit_id": flow_exit.id,
                },
            )


def _exclusive_relationship_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del facts
    document = check_input.document
    nodes = {node.id: node for node in document.nodes}
    pair_groups: dict[tuple[str, str], list[ProjectEdgeRecord]] = defaultdict(list)
    ownership: dict[str, list[ProjectEdgeRecord]] = defaultdict(list)
    for edge in document.edges:
        pair_groups[tuple(sorted((edge.source_node_id, edge.target_node_id)))].append(edge)
        if edge.type == "owns" and nodes[edge.target_node_id].type == "Item":
            ownership[edge.target_node_id].append(edge)

    for pair, edges in sorted(pair_groups.items()):
        types = {edge.type for edge in edges}
        incompatible = {"allied_with", "opposes"}.issubset(types) or (
            "contradicts" in types and len(types) > 1
        )
        if not incompatible:
            continue
        yield _relationship_finding(edges, pair, "incompatible_pair")

    for item_id, edges in sorted(ownership.items()):
        if len({edge.source_node_id for edge in edges}) <= 1:
            continue
        yield _relationship_finding(edges, (item_id,), "multiple_semantic_owners")


def _relationship_finding(
    edges: list[ProjectEdgeRecord],
    node_ids: tuple[str, ...],
    reason: str,
) -> _Finding:
    ordered = sorted(edges, key=lambda edge: edge.id)
    scope = _owner("edge", ordered[0].id)
    targets = tuple(
        [
            *(_owner("edge", edge.id) for edge in ordered),
            *(_owner("node", item) for item in node_ids),
        ]
    )
    return _Finding(
        scope=scope,
        targets=targets,
        evidence=tuple(
            _evidence(_owner("edge", edge.id), "type", excerpt=edge.label or edge.type)
            for edge in ordered
        ),
        message_parameters={"reason": reason, "edge_ids": [edge.id for edge in ordered]},
        recommendation_parameters={"edge_ids": [edge.id for edge in ordered]},
    )


def _custody_disagreement_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del facts
    document = check_input.document
    nodes = {node.id: node for node in document.nodes}
    holder_kinds = {"Character": "character", "Location": "location", "Faction": "faction"}
    owns_by_item: dict[str, list[ProjectEdgeRecord]] = defaultdict(list)
    for edge in document.edges:
        if (
            edge.type == "owns"
            and nodes[edge.target_node_id].type == "Item"
            and nodes[edge.source_node_id].type in holder_kinds
        ):
            owns_by_item[edge.target_node_id].append(edge)

    for state in document.flow_initial_states:
        for custody in state.item_custody:
            for edge in owns_by_item[custody.item_node_id]:
                source = nodes[edge.source_node_id]
                expected = (holder_kinds[source.type], source.id)
                actual = (custody.holder.kind, custody.holder.node_id)
                if actual == expected:
                    continue
                edge_owner = _owner("edge", edge.id)
                state_owner = _owner("initial_state", state.id)
                yield _Finding(
                    scope=state_owner,
                    targets=(edge_owner, state_owner, _owner("node", custody.item_node_id)),
                    evidence=(
                        _evidence(edge_owner, "type", excerpt=edge.label or edge.type),
                        _evidence(state_owner, "item_custody"),
                    ),
                    message_parameters={
                        "flow_id": state.flow_id,
                        "item_node_id": custody.item_node_id,
                        "semantic_holder_node_id": edge.source_node_id,
                        "custody_holder_kind": custody.holder.kind,
                        "custody_holder_node_id": custody.holder.node_id,
                    },
                    recommendation_parameters={"flow_id": state.flow_id},
                )


def _unresolved_condition_findings(
    check_input: CanonCheckInput,
    facts: tuple[CanonFact, ...],
) -> Iterable[_Finding]:
    del facts
    document = check_input.document
    state_by_flow = {
        state.flow_id: _playback_state(state) for state in document.flow_initial_states
    }
    all_states = tuple(state_by_flow.values()) or (PlaybackState(),)
    evaluator = LarkConditionEvaluator()
    for owner, expression, flow_id in _condition_sources(document):
        states = (state_by_flow.get(flow_id, PlaybackState()),) if flow_id else all_states
        results = []
        for state in states:
            try:
                results.append(
                    evaluator.evaluate(
                        {"condition_version": 2, "expression": expression},
                        state,
                    )
                )
            except (TypeError, ValueError):
                results = []
                break
        if results and any(result.status != "invalid" for result in results):
            continue
        diagnostic = next(
            (result.diagnostic_code for result in results if result.diagnostic_code),
            "malformed_condition",
        )
        yield _Finding(
            scope=owner,
            targets=(owner,),
            evidence=(_evidence(owner, "condition", excerpt=expression),),
            message_parameters={"condition": expression, "diagnostic_code": diagnostic},
            recommendation_parameters={"condition": expression},
        )


def _condition_sources(
    document: ProjectDocument,
) -> Iterable[tuple[CanonOwnerRef, str, str | None]]:
    for edge in document.edges:
        if edge.condition.strip():
            yield _owner("edge", edge.id), edge.condition.strip(), None
    for route in document.flow_transitions:
        if route.condition.strip():
            yield _owner("flow_transition", route.id), route.condition.strip(), route.flow_id
    for route in document.flow_invocations:
        if route.condition.strip():
            yield _owner("flow_invocation", route.id), route.condition.strip(), route.source_flow_id
    for owned in document.dialogues:
        dialogue = _owner("node", owned.node_id)
        for element in owned.document.elements:
            raw = element.model_dump(mode="json")
            element_owner = _owner("dialogue_element", element.id, context=dialogue)
            for option in raw.get("options", []):
                if option["condition"].strip():
                    yield (
                        _owner("dialogue_option", option["id"], context=element_owner),
                        option["condition"].strip(),
                        None,
                    )
    for owned in document.quests:
        quest = _owner("node", owned.node_id)
        for stage in owned.document.stages:
            stage_owner = _owner("quest_stage", stage.id, context=quest)
            for branch in stage.branches:
                if branch.condition.strip():
                    yield (
                        _owner("quest_branch", branch.id, context=stage_owner),
                        branch.condition.strip(),
                        None,
                    )


def _playback_state(state: ProjectFlowInitialStateRecord) -> PlaybackState:
    item_holders = {
        custody.item_node_id: custody.holder.model_dump(mode="json")
        for custody in state.item_custody
    }
    return PlaybackState(
        flags=dict(state.flags),
        inventory_node_ids=sorted(
            item_id
            for item_id, holder in item_holders.items()
            if holder["kind"] in {"party", "player"}
        ),
        item_holders=item_holders,
        quest_states=dict(state.quest_statuses),
    )


def _is_specialized_edge(edge: ProjectEdgeRecord) -> bool:
    metadata = edge.metadata
    return any(
        key in metadata
        for key in ("dialogue_element_id", "quest_stage_id", "quest_branch_id")
    )


def _specialized_origin(
    document: ProjectDocument,
    edge: ProjectEdgeRecord,
) -> tuple[CanonOwnerRef | None, str | None]:
    metadata = edge.metadata
    dialogue_id = metadata.get("dialogue_element_id")
    quest_stage_id = metadata.get("quest_stage_id")
    quest_branch_id = metadata.get("quest_branch_id")
    if dialogue_id is not None and (quest_stage_id is not None or quest_branch_id is not None):
        return None, "mixed_specialized_origin"
    if dialogue_id is not None:
        owned = next(
            (item for item in document.dialogues if item.node_id == edge.source_node_id),
            None,
        )
        if owned is None:
            return None, "dialogue_owner_missing"
        dialogue = _owner("node", owned.node_id)
        for element in owned.document.elements:
            if element.kind == "line" and element.id == dialogue_id:
                return _owner("dialogue_element", element.id, context=dialogue), None
            if element.kind == "choice":
                element_owner = _owner("dialogue_element", element.id, context=dialogue)
                if any(option.id == dialogue_id for option in element.options):
                    return _owner("dialogue_option", str(dialogue_id), context=element_owner), None
        return None, "dialogue_origin_stale"
    if quest_stage_id is not None or quest_branch_id is not None:
        if not isinstance(quest_stage_id, str) or not isinstance(quest_branch_id, str):
            return None, "quest_origin_incomplete"
        owned = next(
            (item for item in document.quests if item.node_id == edge.source_node_id),
            None,
        )
        if owned is None:
            return None, "quest_owner_missing"
        quest = _owner("node", owned.node_id)
        for stage in owned.document.stages:
            if stage.id != quest_stage_id:
                continue
            stage_owner = _owner("quest_stage", stage.id, context=quest)
            for branch in stage.branches:
                if branch.id == quest_branch_id and branch.target_stage_id is None:
                    return _owner("quest_branch", branch.id, context=stage_owner), None
        return None, "quest_origin_stale"
    return None, "specialized_origin_missing"


def _valid_outcome_pointer(
    document: ProjectDocument,
    edge: ProjectEdgeRecord,
    *,
    require_target: bool = False,
) -> bool:
    pointer = edge.metadata.get("outcome_flow_composition")
    if not isinstance(pointer, dict):
        return False
    invocation = next(
        (item for item in document.flow_invocations if item.id == pointer.get("invocation_id")),
        None,
    )
    if invocation is None:
        return False
    if (
        invocation.source_flow_id != pointer.get("source_flow_id")
        or invocation.target_flow_id != pointer.get("target_flow_id")
        or invocation.source_node_id != edge.source_node_id
    ):
        return False
    if not require_target:
        return True
    return edge.target_node_id in _reachable_nodes(document, invocation.target_flow_id)


def _direct_outcome_routes(
    document: ProjectDocument,
    edge: ProjectEdgeRecord,
) -> list[ProjectFlowTransitionRecord]:
    return [
        route
        for route in document.flow_transitions
        if route.metadata.get("semantic_edge_id") == edge.id
    ]


def _valid_direct_outcome(
    edge: ProjectEdgeRecord,
    route: ProjectFlowTransitionRecord,
) -> bool:
    if route.source_node_id != edge.source_node_id or route.target_node_id != edge.target_node_id:
        return False
    for key in ("dialogue_element_id", "quest_stage_id", "quest_branch_id"):
        if key in edge.metadata and route.metadata.get(key) != edge.metadata[key]:
            return False
    return True


def _reachable_nodes(document: ProjectDocument, flow_id: str) -> set[str]:
    flow = next((item for item in document.story_flows if item.id == flow_id), None)
    if flow is None or flow.entry_node_id is None:
        return set()
    outgoing: dict[str, set[str]] = defaultdict(set)
    for route in document.flow_transitions:
        if route.flow_id == flow_id:
            outgoing[route.source_node_id].add(route.target_node_id)
    reachable: set[str] = set()
    queue = deque([flow.entry_node_id])
    while queue:
        node_id = queue.popleft()
        if node_id in reachable:
            continue
        reachable.add(node_id)
        queue.extend(sorted(outgoing[node_id] - reachable))
    return reachable


def _owner(
    owner_type: str,
    owner_id: str,
    *,
    context: CanonOwnerRef | None = None,
) -> CanonOwnerRef:
    return CanonOwnerRef(
        owner_type=owner_type,
        owner_id=owner_id,
        context_type=context.owner_type if context else None,
        context_id=context.owner_id if context else None,
    )


def _evidence(
    owner: CanonOwnerRef,
    field_path: str,
    *,
    excerpt: str | None = None,
) -> CanonEvidenceRef:
    return CanonEvidenceRef(
        owner=owner,
        field_path=field_path,
        message_key="canon.evidence.authored-value",
        excerpt=excerpt,
    )


def _candidate_key(candidate: CanonIssueCandidate) -> tuple[str, ...]:
    return (candidate.rule_id, *candidate.scope.stable_key(), candidate.fingerprint)
