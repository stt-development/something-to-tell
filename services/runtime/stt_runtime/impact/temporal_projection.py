"""Temporal state and Playback preparation adapters for Phase 5 impact."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from hashlib import sha256
import json
from typing import Any, Iterable

from ..canon.projection import CanonFactProjector
from ..playback.condition_evaluator import extract_condition_state_paths
from ..schemas.canon_check import CanonFact
from ..schemas.impact_analysis import (
    ImpactDependency,
    ImpactEvidenceRef,
    ImpactResourceRef,
)
from ..schemas.project_document import (
    ProjectDocument,
    ProjectFlowInitialStateRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
)
from .builders import dependency, evidence_ref, resource_ref


@dataclass(frozen=True, order=True)
class _ExecutionState:
    """One context-sensitive Flow position with its exact invocation stack."""

    flow_id: str
    node_id: str
    call_stack: tuple[str, ...] = ()


@dataclass(frozen=True)
class _ExecutionEvent:
    """One executable owner occurrence and the state visible after it runs."""

    owner_kind: str
    owner_id: str
    source: _ExecutionState
    target: _ExecutionState | None


@dataclass
class _ExecutionScope:
    """Finite execution graph for one Flow when selected as Playback root."""

    root_flow_id: str
    states: frozenset[_ExecutionState]
    outgoing: dict[_ExecutionState, frozenset[_ExecutionState]]
    events: dict[tuple[str, str], tuple[_ExecutionEvent, ...]]
    _closure: dict[_ExecutionState, frozenset[_ExecutionState]]

    def can_reach(self, source: _ExecutionState, target: _ExecutionState) -> bool:
        return target in self._closure.get(source, frozenset())

    def can_reach_after_step(
        self,
        source: _ExecutionState,
        target: _ExecutionState,
    ) -> bool:
        return any(
            self.can_reach(next_state, target)
            for next_state in self.outgoing.get(source, frozenset())
        )


@dataclass(frozen=True)
class _ConditionDescriptor:
    """One authored condition and every Flow position where Playback reads it."""

    id: str
    expression: str
    owner: ImpactResourceRef
    positions: frozenset[tuple[str, str]]
    field_path: str

    @property
    def ref(self) -> ImpactResourceRef:
        return resource_ref("condition", _condition_scope_id(self), context=self.owner)


@dataclass(frozen=True)
class _StateValueSpec:
    path: str
    canonical_refs: tuple[ImpactResourceRef, ...]
    field_path: str
    order: int


class TemporalPlaybackDependencyProjector:
    """Project persisted state semantics without creating Playback session data."""

    def project(
        self,
        document: ProjectDocument,
    ) -> tuple[list[ImpactResourceRef], list[ImpactDependency]]:
        resources: list[ImpactResourceRef] = []
        dependencies: list[ImpactDependency] = []
        conditions = _condition_descriptors(document)
        initial_specs: dict[str, tuple[_StateValueSpec, ...]] = {}
        effect_specs: dict[str, tuple[_StateValueSpec, ...]] = {}

        for condition in conditions:
            resources.append(condition.ref)
            dependencies.append(
                dependency(
                    condition.owner,
                    condition.ref,
                    domain="temporal",
                    kind="temporal.condition-owner",
                    propagation="required",
                    message_key="impact.dependency.temporalCondition",
                    evidence=_condition_evidence(condition),
                )
            )

        initial_by_flow: dict[str, ProjectFlowInitialStateRecord] = {}
        initial_value_refs: dict[tuple[str, str], ImpactResourceRef] = {}
        for state in document.flow_initial_states:
            state_ref = _initial_state_ref(state)
            resources.append(state_ref)
            initial_by_flow[state.flow_id] = state
            specs = _initial_state_specs(state)
            initial_specs[state.id] = specs
            dependencies.append(
                dependency(
                    resource_ref("flow", state.flow_id),
                    state_ref,
                    domain="temporal",
                    kind="temporal.initial-state-owner",
                    propagation="required",
                    message_key="impact.dependency.initialState",
                    evidence=_initial_evidence(state, "flow_id"),
                )
            )
            for spec in specs:
                value_ref = _initial_value_ref(state, spec.path)
                resources.append(value_ref)
                initial_value_refs[(state.id, spec.path)] = value_ref
                dependencies.append(
                    dependency(
                        state_ref,
                        value_ref,
                        domain="temporal",
                        kind="temporal.initial-value-owner",
                        propagation="required",
                        message_key="impact.dependency.initialStateValue",
                        parameters={"path": spec.path, "order": spec.order},
                        evidence=_initial_evidence(
                            state,
                            spec.field_path,
                            path=spec.path,
                            order=spec.order,
                        ),
                    )
                )
                dependencies.extend(
                    dependency(
                        canonical,
                        value_ref,
                        domain="temporal",
                        kind="temporal.initial-value-reference",
                        propagation="required",
                        message_key="impact.dependency.temporalCanonicalReference",
                        parameters={"path": spec.path},
                        evidence=_initial_evidence(
                            state,
                            spec.field_path,
                            path=spec.path,
                            order=spec.order,
                        ),
                    )
                    for canonical in spec.canonical_refs
                )

        effects = {effect.id: effect for effect in document.narrative_effects}
        for effect in document.narrative_effects:
            effect_ref = _effect_ref(effect)
            resources.append(effect_ref)
            specs = _effect_specs(effect)
            effect_specs[effect.id] = specs
            for canonical in _effect_canonical_refs(effect):
                dependencies.append(
                    dependency(
                        canonical,
                        effect_ref,
                        domain="temporal",
                        kind="temporal.effect-reference",
                        propagation="required",
                        message_key="impact.dependency.temporalEffectReference",
                        parameters={"operation": effect.operation},
                        evidence=_effect_evidence(effect, "payload"),
                    )
                )

        bindings = {binding.id: binding for binding in document.narrative_effect_bindings}
        binding_owners = {
            binding.id: _binding_owner_ref(document, binding)
            for binding in document.narrative_effect_bindings
        }
        for binding in document.narrative_effect_bindings:
            binding_ref = _binding_ref(binding, binding_owners[binding.id])
            resources.append(binding_ref)
            evidence = _binding_evidence(
                binding,
                binding_ref,
                "application_order",
            )
            dependencies.extend(
                (
                    dependency(
                        _effect_ref(effects[binding.effect_id]),
                        binding_ref,
                        domain="temporal",
                        kind="temporal.binding-effect",
                        propagation="required",
                        message_key="impact.dependency.temporalBinding",
                        parameters={"order": binding.application_order},
                        evidence=evidence,
                    ),
                    dependency(
                        binding_owners[binding.id],
                        binding_ref,
                        domain="temporal",
                        kind="temporal.binding-owner",
                        propagation="required",
                        message_key="impact.dependency.temporalBinding",
                        parameters={"order": binding.application_order},
                        evidence=evidence,
                    ),
                )
            )

        definition_refs: dict[str, ImpactResourceRef] = {}
        for flow in document.story_flows:
            scope = _build_execution_scope(document, flow.id)
            definition_ref = resource_ref(
                "playback_definition",
                flow.id,
                context=resource_ref("flow", flow.id),
            )
            resources.append(definition_ref)
            definition_refs[flow.id] = definition_ref
            dependencies.extend(
                self._playback_structure_dependencies(
                    document,
                    scope,
                    definition_ref,
                )
            )
            reachable_conditions = [
                condition
                for condition in conditions
                if _states_for_positions(scope, condition.positions)
            ]
            read_refs: dict[tuple[str, str], ImpactResourceRef] = {}
            read_states: dict[tuple[str, str], frozenset[_ExecutionState]] = {}
            for condition in reachable_conditions:
                dependencies.append(
                    dependency(
                        condition.ref,
                        definition_ref,
                        domain="playback",
                        kind="playback.condition-input",
                        propagation="required",
                        message_key="impact.dependency.playbackCondition",
                        evidence=_condition_evidence(condition),
                    )
                )
                for path in extract_condition_state_paths(condition.expression):
                    read_ref = _read_ref(flow.id, condition, path)
                    key = (_condition_scope_id(condition), path)
                    resources.append(read_ref)
                    read_refs[key] = read_ref
                    read_states[key] = _states_for_positions(scope, condition.positions)
                    dependencies.extend(
                        (
                            dependency(
                                condition.ref,
                                read_ref,
                                domain="temporal",
                                kind="temporal.condition-read",
                                propagation="required",
                                message_key="impact.dependency.temporalStateRead",
                                parameters={"path": path, "root_flow_id": flow.id},
                                evidence=_condition_evidence(condition, path=path),
                            ),
                            dependency(
                                read_ref,
                                definition_ref,
                                domain="playback",
                                kind="playback.state-read-input",
                                propagation="required",
                                message_key="impact.dependency.playbackStateInput",
                                parameters={"path": path},
                                evidence=_condition_evidence(condition, path=path),
                            ),
                        )
                    )

            initial = initial_by_flow.get(flow.id)
            if initial is not None:
                dependencies.append(
                    dependency(
                        _initial_state_ref(initial),
                        definition_ref,
                        domain="playback",
                        kind="playback.initial-state-input",
                        propagation="required",
                        message_key="impact.dependency.playbackInitialState",
                        evidence=_initial_evidence(initial, "flow_id"),
                    )
                )
                for spec in initial_specs[initial.id]:
                    value_ref = initial_value_refs[(initial.id, spec.path)]
                    dependencies.append(
                        dependency(
                            value_ref,
                            definition_ref,
                            domain="playback",
                            kind="playback.initial-value-input",
                            propagation="required",
                            message_key="impact.dependency.playbackStateInput",
                            parameters={"path": spec.path},
                            evidence=_initial_evidence(
                                initial,
                                spec.field_path,
                                path=spec.path,
                            ),
                        )
                    )
                    for key, read_ref in read_refs.items():
                        if key[1] != spec.path:
                            continue
                        dependencies.append(
                            dependency(
                                value_ref,
                                read_ref,
                                domain="temporal",
                                kind="temporal.initial-value-read",
                                propagation="conditional",
                                message_key="impact.dependency.temporalInitialRead",
                                parameters={"path": spec.path, "root_flow_id": flow.id},
                                evidence=_initial_evidence(
                                    initial,
                                    spec.field_path,
                                    path=spec.path,
                                ),
                            )
                        )

            for binding in document.narrative_effect_bindings:
                occurrences = _binding_occurrences(document, scope, binding)
                if not occurrences:
                    continue
                binding_ref = _binding_ref(binding, binding_owners[binding.id])
                for spec in effect_specs[binding.effect_id]:
                    write_ref = _write_ref(flow.id, binding, binding_ref, spec.path)
                    resources.append(write_ref)
                    evidence = _binding_evidence(
                        binding,
                        binding_ref,
                        "effect_id",
                        path=spec.path,
                        root_flow_id=flow.id,
                    )
                    dependencies.extend(
                        (
                            dependency(
                                binding_ref,
                                write_ref,
                                domain="temporal",
                                kind="temporal.binding-write",
                                propagation="required",
                                message_key="impact.dependency.temporalStateWrite",
                                parameters={"path": spec.path},
                                evidence=evidence,
                            ),
                            dependency(
                                _effect_ref(effects[binding.effect_id]),
                                write_ref,
                                domain="temporal",
                                kind="temporal.effect-write",
                                propagation="required",
                                message_key="impact.dependency.temporalStateWrite",
                                parameters={"path": spec.path},
                                evidence=evidence,
                            ),
                            dependency(
                                write_ref,
                                definition_ref,
                                domain="playback",
                                kind="playback.effect-input",
                                propagation="required",
                                message_key="impact.dependency.playbackEffect",
                                parameters={"path": spec.path},
                                evidence=evidence,
                            ),
                        )
                    )
                    for key, read_ref in read_refs.items():
                        condition = next(
                            item
                            for item in reachable_conditions
                            if _condition_scope_id(item) == key[0]
                        )
                        if key[1] != spec.path or not _write_can_reach_read(
                            document,
                            scope,
                            binding,
                            occurrences,
                            condition,
                            read_states[key],
                        ):
                            continue
                        dependencies.append(
                            dependency(
                                write_ref,
                                read_ref,
                                domain="temporal",
                                kind="temporal.writer-read",
                                propagation="conditional",
                                message_key="impact.dependency.temporalWriterRead",
                                parameters={"path": spec.path, "root_flow_id": flow.id},
                                evidence=evidence,
                            )
                        )

            dependencies.extend(
                _implicit_playback_dependencies(
                    document,
                    scope,
                    definition_ref,
                    reachable_conditions,
                    read_refs,
                    read_states,
                    resources,
                )
            )

        playback_facts = [
            fact
            for fact in CanonFactProjector().project(document).facts
            if fact.domain == "playback"
        ]
        for fact in playback_facts:
            fact_ref = resource_ref("playback_fact", _playback_fact_id(fact))
            resources.append(fact_ref)
            evidence = _playback_fact_evidence(fact, fact_ref)
            owners = (fact.scope, *fact.owners)
            dependencies.extend(
                dependency(
                    owner,
                    fact_ref,
                    domain="playback",
                    kind="playback.fact-owner",
                    propagation="required" if owner == fact.scope else "contextual",
                    message_key="impact.dependency.playbackFact",
                    parameters={"code": fact.code, "level": fact.level},
                    evidence=evidence,
                )
                for owner in owners
            )
            flow_id = next(
                (
                    owner.owner_id
                    for owner in owners
                    if owner.owner_type == "flow" and owner.owner_id in definition_refs
                ),
                None,
            )
            if flow_id is not None:
                dependencies.append(
                    dependency(
                        definition_refs[flow_id],
                        fact_ref,
                        domain="playback",
                        kind="playback.preparation-fact",
                        propagation="required",
                        message_key="impact.dependency.playbackPreparationFact",
                        parameters={"code": fact.code, "level": fact.level},
                        evidence=evidence,
                    )
                )

        return resources, dependencies

    @staticmethod
    def _playback_structure_dependencies(
        document: ProjectDocument,
        scope: _ExecutionScope,
        definition_ref: ImpactResourceRef,
    ) -> list[ImpactDependency]:
        dependencies = [
            dependency(
                resource_ref("flow", scope.root_flow_id),
                definition_ref,
                domain="playback",
                kind="playback.root-flow",
                propagation="required",
                message_key="impact.dependency.playbackDefinition",
                evidence=_playback_evidence(definition_ref, "root_flow_id"),
            )
        ]
        flow_ids = sorted({state.flow_id for state in scope.states} - {scope.root_flow_id})
        dependencies.extend(
            dependency(
                resource_ref("flow", flow_id),
                definition_ref,
                domain="playback",
                kind="playback.reachable-flow",
                propagation="required",
                message_key="impact.dependency.playbackReachableFlow",
                parameters={"root_flow_id": scope.root_flow_id},
                evidence=_playback_evidence(definition_ref, "reachable_flow_ids"),
            )
            for flow_id in flow_ids
        )
        member_by_pair = {
            (item.flow_id, item.node_id): item for item in document.story_flow_nodes
        }
        positions = sorted({(state.flow_id, state.node_id) for state in scope.states})
        dependencies.extend(
            dependency(
                resource_ref(
                    "flow_member",
                    member_by_pair[position].id,
                    context=resource_ref("flow", position[0]),
                ),
                definition_ref,
                domain="playback",
                kind="playback.member-input",
                propagation="required",
                message_key="impact.dependency.playbackMember",
                evidence=_playback_evidence(definition_ref, "members"),
            )
            for position in positions
        )
        return dependencies


def _condition_descriptors(document: ProjectDocument) -> tuple[_ConditionDescriptor, ...]:
    memberships: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for member in document.story_flow_nodes:
        memberships[member.node_id].add((member.flow_id, member.node_id))
    descriptors: list[_ConditionDescriptor] = []
    for transition in document.flow_transitions:
        if transition.condition.strip():
            descriptors.append(
                _ConditionDescriptor(
                    id=transition.id,
                    expression=transition.condition,
                    owner=resource_ref(
                        "flow_transition",
                        transition.id,
                        context=resource_ref("flow", transition.flow_id),
                    ),
                    positions=frozenset(
                        {(transition.flow_id, transition.source_node_id)}
                    ),
                    field_path="condition",
                )
            )
    for invocation in document.flow_invocations:
        if invocation.condition.strip():
            descriptors.append(
                _ConditionDescriptor(
                    id=invocation.id,
                    expression=invocation.condition,
                    owner=resource_ref(
                        "flow_invocation",
                        invocation.id,
                        context=resource_ref("flow", invocation.source_flow_id),
                    ),
                    positions=frozenset(
                        {(invocation.source_flow_id, invocation.source_node_id)}
                    ),
                    field_path="condition",
                )
            )
    for owned in document.dialogues:
        dialogue_ref = resource_ref("node", owned.node_id)
        for element in owned.document.elements:
            options = getattr(element, "options", [])
            if not options:
                continue
            choice_ref = resource_ref("dialogue_element", element.id, context=dialogue_ref)
            for option in options:
                if option.condition.strip():
                    descriptors.append(
                        _ConditionDescriptor(
                            id=option.id,
                            expression=option.condition,
                            owner=resource_ref(
                                "dialogue_option",
                                option.id,
                                context=choice_ref,
                            ),
                            positions=frozenset(memberships.get(owned.node_id, set())),
                            field_path="condition",
                        )
                    )
    for owned in document.quests:
        quest_ref = resource_ref("node", owned.node_id)
        for stage in owned.document.stages:
            stage_ref = resource_ref("quest_stage", stage.id, context=quest_ref)
            for branch in stage.branches:
                if branch.condition.strip():
                    descriptors.append(
                        _ConditionDescriptor(
                            id=branch.id,
                            expression=branch.condition,
                            owner=resource_ref(
                                "quest_branch",
                                branch.id,
                                context=stage_ref,
                            ),
                            positions=frozenset(memberships.get(owned.node_id, set())),
                            field_path="condition",
                        )
                    )
    return tuple(sorted(descriptors, key=lambda item: item.owner.stable_key()))


def _build_execution_scope(document: ProjectDocument, root_flow_id: str) -> _ExecutionScope:
    flows = {flow.id: flow for flow in document.story_flows}
    root_entry = flows[root_flow_id].entry_node_id
    if root_entry is None:
        return _ExecutionScope(root_flow_id, frozenset(), {}, {}, {})
    transitions: dict[tuple[str, str], list[Any]] = defaultdict(list)
    invocations: dict[tuple[str, str], list[Any]] = defaultdict(list)
    exits: dict[tuple[str, str], list[Any]] = defaultdict(list)
    bindings: dict[tuple[str, str], list[Any]] = defaultdict(list)
    invocation_by_id = {item.id: item for item in document.flow_invocations}
    for item in document.flow_transitions:
        transitions[(item.flow_id, item.source_node_id)].append(item)
    for item in document.flow_invocations:
        invocations[(item.source_flow_id, item.source_node_id)].append(item)
    for item in document.flow_exits:
        exits[(item.flow_id, item.source_node_id)].append(item)
    for item in document.flow_exit_bindings:
        bindings[(item.invocation_id, item.exit_id)].append(item)

    start = _ExecutionState(root_flow_id, root_entry)
    pending = deque([start])
    seen: set[_ExecutionState] = set()
    outgoing: dict[_ExecutionState, set[_ExecutionState]] = defaultdict(set)
    events: dict[tuple[str, str], list[_ExecutionEvent]] = defaultdict(list)
    while pending:
        state = pending.popleft()
        if state in seen:
            continue
        seen.add(state)
        position = (state.flow_id, state.node_id)
        flow_exits = sorted(exits.get(position, []), key=lambda item: item.id)
        if flow_exits:
            for flow_exit in flow_exits:
                targets: list[_ExecutionState] = []
                if state.call_stack:
                    invocation_id = state.call_stack[-1]
                    invocation = invocation_by_id[invocation_id]
                    targets.extend(
                        _ExecutionState(
                            invocation.source_flow_id,
                            binding.target_node_id,
                            state.call_stack[:-1],
                        )
                        for binding in bindings.get((invocation_id, flow_exit.id), [])
                    )
                if not targets:
                    events[("flow_exit", flow_exit.id)].append(
                        _ExecutionEvent("flow_exit", flow_exit.id, state, None)
                    )
                for target in targets:
                    outgoing[state].add(target)
                    events[("flow_exit", flow_exit.id)].append(
                        _ExecutionEvent("flow_exit", flow_exit.id, state, target)
                    )
                    pending.append(target)
            continue
        for transition in sorted(
            transitions.get(position, []),
            key=lambda item: (item.priority, item.id),
        ):
            target = _ExecutionState(
                transition.flow_id,
                transition.target_node_id,
                state.call_stack,
            )
            outgoing[state].add(target)
            events[("flow_transition", transition.id)].append(
                _ExecutionEvent("flow_transition", transition.id, state, target)
            )
            pending.append(target)
        for invocation in sorted(
            invocations.get(position, []),
            key=lambda item: (item.priority, item.id),
        ):
            entry = flows[invocation.target_flow_id].entry_node_id
            if entry is None:
                continue
            target = _ExecutionState(
                invocation.target_flow_id,
                entry,
                (*state.call_stack, invocation.id),
            )
            outgoing[state].add(target)
            events[("flow_invocation", invocation.id)].append(
                _ExecutionEvent("flow_invocation", invocation.id, state, target)
            )
            pending.append(target)

    frozen_outgoing = {key: frozenset(value) for key, value in outgoing.items()}
    closure = {
        state: _reachable_states(state, frozen_outgoing)
        for state in sorted(seen)
    }
    return _ExecutionScope(
        root_flow_id=root_flow_id,
        states=frozenset(seen),
        outgoing=frozen_outgoing,
        events={key: tuple(value) for key, value in events.items()},
        _closure=closure,
    )


def _reachable_states(
    start: _ExecutionState,
    outgoing: dict[_ExecutionState, frozenset[_ExecutionState]],
) -> frozenset[_ExecutionState]:
    reached = {start}
    pending = [start]
    while pending:
        current = pending.pop()
        for target in outgoing.get(current, frozenset()):
            if target not in reached:
                reached.add(target)
                pending.append(target)
    return frozenset(reached)


def _binding_occurrences(
    document: ProjectDocument,
    scope: _ExecutionScope,
    binding: ProjectNarrativeEffectBindingRecord,
) -> tuple[_ExecutionEvent, ...]:
    if binding.owner_kind in {"flow_transition", "flow_invocation", "flow_exit"}:
        return scope.events.get((binding.owner_kind, binding.owner_id), ())
    if binding.owner_kind in {"quest_branch", "quest_outcome"}:
        transition_ids = [
            transition.id
            for transition in document.flow_transitions
            if transition.metadata.get("quest_branch_id") == binding.owner_id
        ]
        occurrences = [
            occurrence
            for transition_id in transition_ids
            for occurrence in scope.events.get(("flow_transition", transition_id), ())
        ]
        if occurrences:
            return tuple(occurrences)
    node_id = binding.context_node_id or binding.owner_id
    return tuple(
        _ExecutionEvent(binding.owner_kind, binding.owner_id, state, state)
        for state in sorted(scope.states)
        if state.node_id == node_id
    )


def _write_can_reach_read(
    document: ProjectDocument,
    scope: _ExecutionScope,
    binding: ProjectNarrativeEffectBindingRecord,
    occurrences: tuple[_ExecutionEvent, ...],
    condition: _ConditionDescriptor,
    read_states: frozenset[_ExecutionState],
) -> bool:
    for occurrence in occurrences:
        if occurrence.target is None:
            continue
        for read_state in read_states:
            if occurrence.target != read_state:
                if scope.can_reach(occurrence.target, read_state):
                    return True
                continue
            if binding.owner_kind not in {"dialogue_element", "dialogue_option"}:
                return True
            if condition.owner.owner_type != "dialogue_option":
                return True
            if scope.can_reach_after_step(occurrence.target, read_state):
                return True
            if _dialogue_owner_precedes_option(
                document,
                binding.owner_kind,
                binding.context_node_id,
                binding.owner_id,
                condition.id,
            ):
                return True
    return False


def _dialogue_owner_precedes_option(
    document: ProjectDocument,
    owner_kind: str,
    context_node_id: str | None,
    owner_id: str,
    target_option_id: str,
) -> bool:
    """Resolve only forward internal Dialogue order, never sibling label similarity."""

    if owner_kind != "dialogue_option" or context_node_id is None:
        return False
    owned = next(
        (item for item in document.dialogues if item.node_id == context_node_id),
        None,
    )
    if owned is None:
        return False
    elements = {element.id: element for element in owned.document.elements}
    source_option = next(
        (
            option
            for element in owned.document.elements
            for option in getattr(element, "options", [])
            if option.id == owner_id
        ),
        None,
    )
    target_choice_id = next(
        (
            element.id
            for element in owned.document.elements
            if any(
                option.id == target_option_id
                for option in getattr(element, "options", [])
            )
        ),
        None,
    )
    if source_option is None or source_option.next_element_id is None:
        return False
    pending = [source_option.next_element_id]
    reached: set[str] = set()
    while pending:
        element_id = pending.pop()
        if element_id in reached:
            continue
        reached.add(element_id)
        if element_id == target_choice_id:
            return True
        element = elements[element_id]
        next_ids = (
            [element.next_element_id]
            if hasattr(element, "next_element_id")
            else [option.next_element_id for option in getattr(element, "options", [])]
        )
        pending.extend(next_id for next_id in next_ids if next_id is not None)
    return False


def _states_for_positions(
    scope: _ExecutionScope,
    positions: Iterable[tuple[str, str]],
) -> frozenset[_ExecutionState]:
    accepted = set(positions)
    return frozenset(
        state for state in scope.states if (state.flow_id, state.node_id) in accepted
    )


def _implicit_playback_dependencies(
    document: ProjectDocument,
    scope: _ExecutionScope,
    definition_ref: ImpactResourceRef,
    conditions: list[_ConditionDescriptor],
    read_refs: dict[tuple[str, str], ImpactResourceRef],
    read_states: dict[tuple[str, str], frozenset[_ExecutionState]],
    resources: list[ImpactResourceRef],
) -> list[ImpactDependency]:
    dependencies: list[ImpactDependency] = []
    conditions_by_key = {_condition_scope_id(item): item for item in conditions}
    members = {
        (item.flow_id, item.node_id): item for item in document.story_flow_nodes
    }
    for key, read_ref in read_refs.items():
        path = key[1]
        if path.startswith("visited."):
            dependencies.extend(
                _implicit_visited_dependencies(
                    scope,
                    definition_ref,
                    path,
                    read_ref,
                    read_states[key],
                    members,
                    resources,
                )
            )
        if not path.startswith("dialogue.") or not path.endswith(".choices"):
            continue
        dialogue_id = path.split(".")[1]
        owned = next(
            (item for item in document.dialogues if item.node_id == dialogue_id),
            None,
        )
        if owned is None:
            continue
        target_condition = conditions_by_key[key[0]]
        dialogue_states = [
            state for state in sorted(scope.states) if state.node_id == dialogue_id
        ]
        for element in owned.document.elements:
            choice_ref = resource_ref(
                "dialogue_element",
                element.id,
                context=resource_ref("node", dialogue_id),
            )
            for option in getattr(element, "options", []):
                option_ref = resource_ref(
                    "dialogue_option",
                    option.id,
                    context=choice_ref,
                )
                writer_ref = resource_ref(
                    "playback_state_write",
                    f"{scope.root_flow_id}:dialogue:{dialogue_id}:{option.id}",
                    context=definition_ref,
                )
                resources.append(writer_ref)
                evidence = _playback_evidence(
                    writer_ref,
                    "dialogue_choice_ids",
                    path=path,
                    option_id=option.id,
                )
                dependencies.extend(
                    (
                        dependency(
                            option_ref,
                            writer_ref,
                            domain="playback",
                            kind="playback.dialogue-choice-write",
                            propagation="required",
                            message_key="impact.dependency.playbackDialogueWrite",
                            evidence=evidence,
                        ),
                        dependency(
                            writer_ref,
                            definition_ref,
                            domain="playback",
                            kind="playback.state-write-input",
                            propagation="required",
                            message_key="impact.dependency.playbackStateInput",
                            parameters={"path": path},
                            evidence=evidence,
                        ),
                    )
                )
                precedes_in_dialogue = _dialogue_option_precedes_condition(
                    document,
                    dialogue_id,
                    option.id,
                    target_condition,
                )
                if any(
                    (
                        state != target and scope.can_reach(state, target)
                    )
                    or (
                        state == target
                        and (
                            scope.can_reach_after_step(state, target)
                            or precedes_in_dialogue
                        )
                    )
                    for state in dialogue_states
                    for target in read_states[key]
                ):
                    dependencies.append(
                        dependency(
                            writer_ref,
                            read_ref,
                            domain="playback",
                            kind="playback.dialogue-choice-read",
                            propagation="conditional",
                            message_key="impact.dependency.playbackDialogueRead",
                            parameters={"path": path},
                            evidence=evidence,
                        )
                    )
    return dependencies


def _implicit_visited_dependencies(
    scope: _ExecutionScope,
    definition_ref: ImpactResourceRef,
    path: str,
    read_ref: ImpactResourceRef,
    read_states: frozenset[_ExecutionState],
    members: dict[tuple[str, str], Any],
    resources: list[ImpactResourceRef],
) -> list[ImpactDependency]:
    dependencies: list[ImpactDependency] = []
    node_id = path.split(".", 1)[1]
    for state in sorted(scope.states):
        if state.node_id != node_id:
            continue
        writer_ref = resource_ref(
            "playback_state_write",
            f"{scope.root_flow_id}:visited:{state.flow_id}:{node_id}",
            context=definition_ref,
        )
        resources.append(writer_ref)
        member = members[(state.flow_id, node_id)]
        member_ref = resource_ref(
            "flow_member",
            member.id,
            context=resource_ref("flow", state.flow_id),
        )
        evidence = _playback_evidence(writer_ref, "visited_node_ids", path=path)
        dependencies.extend(
            (
                dependency(
                    member_ref,
                    writer_ref,
                    domain="playback",
                    kind="playback.visited-write",
                    propagation="required",
                    message_key="impact.dependency.playbackVisitedWrite",
                    evidence=evidence,
                ),
                dependency(
                    writer_ref,
                    definition_ref,
                    domain="playback",
                    kind="playback.state-write-input",
                    propagation="required",
                    message_key="impact.dependency.playbackStateInput",
                    parameters={"path": path},
                    evidence=evidence,
                ),
            )
        )
        if any(scope.can_reach(state, target) for target in read_states):
            dependencies.append(
                dependency(
                    writer_ref,
                    read_ref,
                    domain="playback",
                    kind="playback.visited-read",
                    propagation="conditional",
                    message_key="impact.dependency.playbackVisitedRead",
                    parameters={"path": path},
                    evidence=evidence,
                )
            )
    return dependencies


def _dialogue_option_precedes_condition(
    document: ProjectDocument,
    dialogue_id: str,
    option_id: str,
    condition: _ConditionDescriptor,
) -> bool:
    if condition.owner.owner_type != "dialogue_option":
        return True
    return _dialogue_owner_precedes_option(
        document,
        "dialogue_option",
        dialogue_id,
        option_id,
        condition.id,
    )


def _initial_state_specs(
    state: ProjectFlowInitialStateRecord,
) -> tuple[_StateValueSpec, ...]:
    specs: list[_StateValueSpec] = []
    for order, flag in enumerate(sorted(state.flags)):
        specs.append(_StateValueSpec(f"flags.{flag}", (), f"flags.{flag}", order))
    for order, custody in enumerate(state.item_custody):
        canonical = [resource_ref("node", custody.item_node_id)]
        if custody.holder.node_id is not None:
            canonical.append(resource_ref("node", custody.holder.node_id))
        for path in (
            f"items.{custody.item_node_id}.holder.kind",
            f"items.{custody.item_node_id}.holder.node_id",
            f"inventory.{custody.item_node_id}",
        ):
            specs.append(
                _StateValueSpec(
                    path,
                    tuple(canonical),
                    f"item_custody.{order}",
                    order,
                )
            )
    offset = len(specs)
    for order, quest_id in enumerate(sorted(state.quest_statuses)):
        specs.append(
            _StateValueSpec(
                f"quests.{quest_id}.status",
                (resource_ref("node", quest_id),),
                f"quest_statuses.{quest_id}",
                offset + order,
            )
        )
    return tuple(specs)


def _effect_specs(effect: ProjectNarrativeEffectRecord) -> tuple[_StateValueSpec, ...]:
    payload = effect.payload
    if effect.operation in {"set_flag", "clear_flag"}:
        return (_StateValueSpec(f"flags.{payload['flag']}", (), "payload.flag", 0),)
    if effect.operation == "transfer_item":
        item_id = str(payload["item_node_id"])
        return tuple(
            _StateValueSpec(path, (), "payload.item_node_id", order)
            for order, path in enumerate(
                (
                    f"items.{item_id}.holder.kind",
                    f"items.{item_id}.holder.node_id",
                    f"inventory.{item_id}",
                )
            )
        )
    if effect.operation == "set_quest_status":
        return (
            _StateValueSpec(
                f"quests.{payload['quest_node_id']}.status",
                (),
                "payload.quest_node_id",
                0,
            ),
        )
    if effect.operation == "record_dialogue_choice":
        return (
            _StateValueSpec(
                f"dialogue.{payload['dialogue_node_id']}.choices",
                (),
                "payload.dialogue_node_id",
                0,
            ),
        )
    return ()


def _effect_canonical_refs(
    effect: ProjectNarrativeEffectRecord,
) -> tuple[ImpactResourceRef, ...]:
    payload = effect.payload
    node_ids: set[str] = set()
    for key in ("item_node_id", "quest_node_id", "dialogue_node_id"):
        value = payload.get(key)
        if isinstance(value, str):
            node_ids.add(value)
    for key in ("from_holder", "to_holder"):
        holder = payload.get(key)
        if isinstance(holder, dict) and isinstance(holder.get("node_id"), str):
            node_ids.add(holder["node_id"])
    return tuple(resource_ref("node", node_id) for node_id in sorted(node_ids))


def _binding_owner_ref(
    document: ProjectDocument,
    binding: ProjectNarrativeEffectBindingRecord,
) -> ImpactResourceRef:
    if binding.owner_kind == "node_entry":
        return resource_ref(
            "node_entry",
            binding.owner_id,
            context=resource_ref("node", binding.owner_id),
        )
    if binding.owner_kind == "flow_transition":
        record = next(item for item in document.flow_transitions if item.id == binding.owner_id)
        return resource_ref(
            "flow_transition",
            record.id,
            context=resource_ref("flow", record.flow_id),
        )
    if binding.owner_kind == "flow_invocation":
        record = next(item for item in document.flow_invocations if item.id == binding.owner_id)
        return resource_ref(
            "flow_invocation",
            record.id,
            context=resource_ref("flow", record.source_flow_id),
        )
    if binding.owner_kind == "flow_exit":
        record = next(item for item in document.flow_exits if item.id == binding.owner_id)
        return resource_ref(
            "flow_exit",
            record.id,
            context=resource_ref("flow", record.flow_id),
        )
    if binding.owner_kind == "dialogue_element":
        return resource_ref(
            "dialogue_element",
            binding.owner_id,
            context=resource_ref("node", binding.context_node_id or ""),
        )
    if binding.owner_kind == "dialogue_option":
        owned = next(item for item in document.dialogues if item.node_id == binding.context_node_id)
        choice = next(
            element
            for element in owned.document.elements
            if any(option.id == binding.owner_id for option in getattr(element, "options", []))
        )
        return resource_ref(
            "dialogue_option",
            binding.owner_id,
            context=resource_ref(
                "dialogue_element",
                choice.id,
                context=resource_ref("node", owned.node_id),
            ),
        )
    if binding.owner_kind == "quest_branch":
        owned = next(item for item in document.quests if item.node_id == binding.context_node_id)
        stage = next(
            stage
            for stage in owned.document.stages
            if any(branch.id == binding.owner_id for branch in stage.branches)
        )
        return resource_ref(
            "quest_branch",
            binding.owner_id,
            context=resource_ref(
                "quest_stage",
                stage.id,
                context=resource_ref("node", owned.node_id),
            ),
        )
    return resource_ref(
        "quest_outcome",
        binding.owner_id,
        context=resource_ref("node", binding.context_node_id or ""),
    )


def _initial_state_ref(state: ProjectFlowInitialStateRecord) -> ImpactResourceRef:
    return resource_ref(
        "initial_state",
        state.id,
        context=resource_ref("flow", state.flow_id),
    )


def _initial_value_ref(
    state: ProjectFlowInitialStateRecord,
    path: str,
) -> ImpactResourceRef:
    return resource_ref(
        "initial_state_value",
        f"{state.id}:{path}",
        context=_initial_state_ref(state),
    )


def _effect_ref(effect: ProjectNarrativeEffectRecord) -> ImpactResourceRef:
    return resource_ref("effect", effect.id)


def _binding_ref(
    binding: ProjectNarrativeEffectBindingRecord,
    owner: ImpactResourceRef,
) -> ImpactResourceRef:
    return resource_ref("effect_binding", binding.id, context=owner)


def _read_ref(
    root_flow_id: str,
    condition: _ConditionDescriptor,
    path: str,
) -> ImpactResourceRef:
    return resource_ref(
        "state_read",
        f"{root_flow_id}:{_condition_scope_id(condition)}:{path}",
        context=condition.ref,
    )


def _write_ref(
    root_flow_id: str,
    binding: ProjectNarrativeEffectBindingRecord,
    binding_ref: ImpactResourceRef,
    path: str,
) -> ImpactResourceRef:
    return resource_ref(
        "state_write",
        f"{root_flow_id}:{binding.id}:{path}",
        context=binding_ref,
    )


def _condition_evidence(
    condition: _ConditionDescriptor,
    **parameters: Any,
) -> ImpactEvidenceRef:
    return evidence_ref(
        condition.owner,
        field_path=condition.field_path,
        message_key="impact.evidence.temporalCondition",
        parameters=parameters,
        excerpt=condition.expression,
    )


def _condition_scope_id(condition: _ConditionDescriptor) -> str:
    owner = condition.owner
    return ":".join(
        part
        for part in (
            owner.context_type,
            owner.context_id,
            owner.owner_type,
            owner.owner_id,
        )
        if part is not None
    )


def _initial_evidence(
    state: ProjectFlowInitialStateRecord,
    field_path: str,
    **parameters: Any,
) -> ImpactEvidenceRef:
    return evidence_ref(
        _initial_state_ref(state),
        field_path=field_path,
        message_key="impact.evidence.initialState",
        parameters=parameters,
    )


def _effect_evidence(
    effect: ProjectNarrativeEffectRecord,
    field_path: str,
) -> ImpactEvidenceRef:
    return evidence_ref(
        _effect_ref(effect),
        field_path=field_path,
        message_key="impact.evidence.temporalEffect",
        parameters={"operation": effect.operation},
        excerpt=effect.explanation,
    )


def _binding_evidence(
    binding: ProjectNarrativeEffectBindingRecord,
    binding_ref: ImpactResourceRef,
    field_path: str,
    **parameters: Any,
) -> ImpactEvidenceRef:
    return evidence_ref(
        binding_ref,
        field_path=field_path,
        message_key="impact.evidence.temporalBinding",
        parameters={"order": binding.application_order, **parameters},
    )


def _playback_evidence(
    owner: ImpactResourceRef,
    field_path: str,
    **parameters: Any,
) -> ImpactEvidenceRef:
    return evidence_ref(
        owner,
        field_path=field_path,
        message_key="impact.evidence.playbackDefinition",
        parameters=parameters,
    )


def _playback_fact_id(fact: CanonFact) -> str:
    identity = {
        "code": fact.code,
        "level": fact.level,
        "scope": fact.scope.model_dump(mode="json"),
        "owners": [owner.model_dump(mode="json") for owner in fact.owners],
        "parameters": fact.parameters,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    return sha256(encoded.encode("utf-8")).hexdigest()


def _playback_fact_evidence(
    fact: CanonFact,
    fact_ref: ImpactResourceRef,
) -> ImpactEvidenceRef:
    return evidence_ref(
        fact_ref,
        field_path="code",
        message_key="impact.evidence.playbackFact",
        parameters={"code": fact.code, "level": fact.level},
    )
