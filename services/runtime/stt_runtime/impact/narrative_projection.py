"""Story Flow, Dialogue, and Quest dependency adapters for Phase 5."""

from __future__ import annotations

from typing import Any

from ..schemas.dialogue import DialogueChoiceElement, DialogueLineElement
from ..schemas.impact_analysis import (
    ImpactDependency,
    ImpactEvidenceRef,
    ImpactPropagation,
    ImpactResourceRef,
)
from ..schemas.project_document import (
    OwnedDialogueDocument,
    OwnedQuestDocument,
    ProjectDocument,
    ProjectEdgeRecord,
    ProjectFlowExitBindingRecord,
    ProjectFlowExitRecord,
    ProjectFlowInvocationRecord,
    ProjectFlowTransitionRecord,
    ProjectSceneFlowBoundaryRecord,
    ProjectStoryFlowNodeRecord,
    ProjectStoryFlowRecord,
)
from .builders import dependency, evidence_ref, resource_ref


class NarrativeStructureDependencyProjector:
    """Projects executable authoring records without invoking integrity services."""

    def resources(self, document: ProjectDocument) -> list[ImpactResourceRef]:
        resources = [
            *(resource_ref("flow", item.id) for item in document.story_flows),
            *(self._member_ref(item) for item in document.story_flow_nodes),
            *(
                self._flow_record_ref("flow_transition", item.id, item.flow_id)
                for item in document.flow_transitions
            ),
            *(
                self._flow_record_ref("scene_boundary", item.id, item.flow_id)
                for item in document.scene_flow_boundaries
            ),
            *(
                self._flow_record_ref("flow_invocation", item.id, item.source_flow_id)
                for item in document.flow_invocations
            ),
            *(self._flow_record_ref("flow_exit", item.id, item.flow_id) for item in document.flow_exits),
            *(resource_ref("flow_exit_binding", item.id) for item in document.flow_exit_bindings),
        ]
        for flow in document.story_flows:
            if flow.entry_node_id is not None:
                resources.append(self._flow_marker_ref("flow_entry", flow.entry_node_id, flow.id))
        outgoing = {
            (item.flow_id, item.source_node_id) for item in document.flow_transitions
        } | {
            (item.source_flow_id, item.source_node_id) for item in document.flow_invocations
        }
        resources.extend(
            self._flow_marker_ref("flow_terminal", member.node_id, member.flow_id)
            for member in document.story_flow_nodes
            if (member.flow_id, member.node_id) not in outgoing
        )
        for owned in document.dialogues:
            resources.extend(self._dialogue_resources(owned))
        for owned in document.quests:
            resources.extend(self._quest_resources(owned))
        return resources

    def project(self, document: ProjectDocument) -> list[ImpactDependency]:
        return [
            *self._flow_dependencies(document),
            *self._dialogue_dependencies(document),
            *self._quest_dependencies(document),
        ]

    def _flow_dependencies(self, document: ProjectDocument) -> list[ImpactDependency]:
        dependencies: list[ImpactDependency] = []
        member_by_pair = {
            (member.flow_id, member.node_id): member
            for member in document.story_flow_nodes
        }
        invocation_by_id = {item.id: item for item in document.flow_invocations}
        exit_by_id = {item.id: item for item in document.flow_exits}

        for member in document.story_flow_nodes:
            flow_ref = resource_ref("flow", member.flow_id)
            member_ref = self._member_ref(member)
            evidence = self._flow_evidence(
                member_ref,
                "presentation_order",
                order=member.presentation_order,
            )
            dependencies.extend(
                (
                    dependency(
                        flow_ref,
                        member_ref,
                        domain="flow",
                        kind="flow.membership-owner",
                        propagation="required",
                        message_key="impact.dependency.flowMembership",
                        evidence=evidence,
                    ),
                    dependency(
                        resource_ref("node", member.node_id),
                        member_ref,
                        domain="flow",
                        kind="flow.membership-node",
                        propagation="required",
                        message_key="impact.dependency.flowMembership",
                        evidence=evidence,
                    ),
                )
            )

        for flow in document.story_flows:
            if flow.entry_node_id is None:
                continue
            member = member_by_pair[(flow.id, flow.entry_node_id)]
            marker = self._flow_marker_ref("flow_entry", flow.entry_node_id, flow.id)
            evidence = self._flow_evidence(resource_ref("flow", flow.id), "entry_node_id")
            dependencies.extend(
                (
                    dependency(
                        resource_ref("flow", flow.id),
                        marker,
                        domain="flow",
                        kind="flow.entry-owner",
                        propagation="required",
                        message_key="impact.dependency.flowEntry",
                        evidence=evidence,
                    ),
                    dependency(
                        self._member_ref(member),
                        marker,
                        domain="flow",
                        kind="flow.entry-member",
                        propagation="required",
                        message_key="impact.dependency.flowEntry",
                        evidence=evidence,
                    ),
                )
            )

        for transition in document.flow_transitions:
            dependencies.extend(
                self._transition_dependencies(transition, member_by_pair)
            )
        for invocation in document.flow_invocations:
            dependencies.extend(
                self._invocation_dependencies(invocation, member_by_pair)
            )
        for flow_exit in document.flow_exits:
            dependencies.extend(self._exit_dependencies(flow_exit, member_by_pair))
        for binding in document.flow_exit_bindings:
            dependencies.extend(
                self._binding_dependencies(
                    binding,
                    invocation_by_id[binding.invocation_id],
                    exit_by_id[binding.exit_id],
                    member_by_pair,
                )
            )
        for boundary in document.scene_flow_boundaries:
            dependencies.extend(self._boundary_dependencies(boundary, member_by_pair))

        outgoing = {
            (item.flow_id, item.source_node_id) for item in document.flow_transitions
        } | {
            (item.source_flow_id, item.source_node_id) for item in document.flow_invocations
        }
        for member in document.story_flow_nodes:
            if (member.flow_id, member.node_id) in outgoing:
                continue
            marker = self._flow_marker_ref("flow_terminal", member.node_id, member.flow_id)
            dependencies.append(
                dependency(
                    self._member_ref(member),
                    marker,
                    domain="flow",
                    kind="flow.terminal-member",
                    propagation="required",
                    message_key="impact.dependency.flowTerminal",
                    evidence=self._flow_evidence(marker, None),
                )
            )

        return dependencies

    def _transition_dependencies(
        self,
        transition: ProjectFlowTransitionRecord,
        members: dict[tuple[str, str], ProjectStoryFlowNodeRecord],
    ) -> tuple[ImpactDependency, ...]:
        transition_ref = self._flow_record_ref(
            "flow_transition",
            transition.id,
            transition.flow_id,
        )
        source_member = self._member_ref(
            members[(transition.flow_id, transition.source_node_id)]
        )
        target_member = self._member_ref(
            members[(transition.flow_id, transition.target_node_id)]
        )
        evidence = self._transition_evidence(transition, "target_node_id")
        propagation = _execution_propagation(
            condition=transition.condition,
            kind=transition.kind,
            is_default=transition.is_default,
        )
        return (
            dependency(
                resource_ref("flow", transition.flow_id),
                transition_ref,
                domain="flow",
                kind="flow.transition-owner",
                propagation="required",
                message_key="impact.dependency.flowTransition",
                evidence=evidence,
            ),
            dependency(
                source_member,
                transition_ref,
                domain="flow",
                kind="flow.transition-source",
                propagation="required",
                message_key="impact.dependency.flowTransition",
                evidence=evidence,
            ),
            dependency(
                target_member,
                transition_ref,
                domain="flow",
                kind="flow.transition-target",
                propagation="required",
                message_key="impact.dependency.flowTransition",
                evidence=evidence,
            ),
            dependency(
                transition_ref,
                target_member,
                domain="flow",
                kind="flow.transition-reachability",
                propagation=propagation,
                message_key="impact.dependency.flowReachability",
                parameters={"kind": transition.kind, "condition": bool(transition.condition)},
                evidence=evidence,
            ),
        )

    def _invocation_dependencies(
        self,
        invocation: ProjectFlowInvocationRecord,
        members: dict[tuple[str, str], ProjectStoryFlowNodeRecord],
    ) -> tuple[ImpactDependency, ...]:
        invocation_ref = self._flow_record_ref(
            "flow_invocation",
            invocation.id,
            invocation.source_flow_id,
        )
        source_member = self._member_ref(
            members[(invocation.source_flow_id, invocation.source_node_id)]
        )
        target_flow = resource_ref("flow", invocation.target_flow_id)
        evidence = self._invocation_evidence(invocation, "target_flow_id")
        propagation: ImpactPropagation = (
            "required" if invocation.is_default and not invocation.condition else "conditional"
        )
        return (
            dependency(
                resource_ref("flow", invocation.source_flow_id),
                invocation_ref,
                domain="flow",
                kind="flow.invocation-caller",
                propagation="required",
                message_key="impact.dependency.flowInvocation",
                evidence=evidence,
            ),
            dependency(
                source_member,
                invocation_ref,
                domain="flow",
                kind="flow.invocation-source",
                propagation="required",
                message_key="impact.dependency.flowInvocation",
                evidence=evidence,
            ),
            dependency(
                target_flow,
                invocation_ref,
                domain="flow",
                kind="flow.invocation-callee",
                propagation="required",
                message_key="impact.dependency.flowInvocation",
                evidence=evidence,
            ),
            dependency(
                invocation_ref,
                target_flow,
                domain="flow",
                kind="flow.invocation-reachability",
                propagation=propagation,
                message_key="impact.dependency.flowCallReachability",
                evidence=evidence,
            ),
        )

    def _exit_dependencies(
        self,
        flow_exit: ProjectFlowExitRecord,
        members: dict[tuple[str, str], ProjectStoryFlowNodeRecord],
    ) -> tuple[ImpactDependency, ...]:
        exit_ref = self._flow_record_ref("flow_exit", flow_exit.id, flow_exit.flow_id)
        evidence = self._exit_evidence(flow_exit, "source_node_id")
        return (
            dependency(
                resource_ref("flow", flow_exit.flow_id),
                exit_ref,
                domain="flow",
                kind="flow.exit-owner",
                propagation="required",
                message_key="impact.dependency.flowExit",
                evidence=evidence,
            ),
            dependency(
                self._member_ref(members[(flow_exit.flow_id, flow_exit.source_node_id)]),
                exit_ref,
                domain="flow",
                kind="flow.exit-source",
                propagation="required",
                message_key="impact.dependency.flowExit",
                evidence=evidence,
            ),
        )

    def _binding_dependencies(
        self,
        binding: ProjectFlowExitBindingRecord,
        invocation: ProjectFlowInvocationRecord,
        flow_exit: ProjectFlowExitRecord,
        members: dict[tuple[str, str], ProjectStoryFlowNodeRecord],
    ) -> tuple[ImpactDependency, ...]:
        binding_ref = resource_ref("flow_exit_binding", binding.id)
        invocation_ref = self._flow_record_ref(
            "flow_invocation",
            invocation.id,
            invocation.source_flow_id,
        )
        exit_ref = self._flow_record_ref("flow_exit", flow_exit.id, flow_exit.flow_id)
        target_member = self._member_ref(
            members[(invocation.source_flow_id, binding.target_node_id)]
        )
        evidence = self._binding_evidence(binding, "target_node_id")
        return (
            dependency(
                invocation_ref,
                binding_ref,
                domain="flow",
                kind="flow.binding-invocation",
                propagation="required",
                message_key="impact.dependency.flowReturnBinding",
                evidence=evidence,
            ),
            dependency(
                exit_ref,
                binding_ref,
                domain="flow",
                kind="flow.binding-exit",
                propagation="required",
                message_key="impact.dependency.flowReturnBinding",
                evidence=evidence,
            ),
            dependency(
                target_member,
                binding_ref,
                domain="flow",
                kind="flow.binding-target",
                propagation="required",
                message_key="impact.dependency.flowReturnBinding",
                evidence=evidence,
            ),
            dependency(
                binding_ref,
                target_member,
                domain="flow",
                kind="flow.binding-reachability",
                propagation="required",
                message_key="impact.dependency.flowReturnReachability",
                evidence=evidence,
            ),
        )

    def _boundary_dependencies(
        self,
        boundary: ProjectSceneFlowBoundaryRecord,
        members: dict[tuple[str, str], ProjectStoryFlowNodeRecord],
    ) -> tuple[ImpactDependency, ...]:
        boundary_ref = self._flow_record_ref(
            "scene_boundary",
            boundary.id,
            boundary.flow_id,
        )
        owners = [
            ("flow.boundary-owner", resource_ref("flow", boundary.flow_id), "required"),
            (
                "flow.boundary-scene",
                self._member_ref(members[(boundary.flow_id, boundary.scene_node_id)]),
                "required",
            ),
            (
                "flow.boundary-entry-owner",
                self._member_ref(members[(boundary.flow_id, boundary.entry_node_id)]),
                "required",
            ),
            *(
                (
                    "flow.boundary-exit-owner",
                    self._member_ref(members[(boundary.flow_id, node_id)]),
                    "required",
                )
                for node_id in boundary.exit_node_ids
            ),
        ]
        dependencies = [
            dependency(
                owner,
                boundary_ref,
                domain="flow",
                kind=kind,
                propagation=propagation,
                message_key="impact.dependency.sceneBoundary",
                evidence=self._boundary_evidence(boundary, "scene_node_id"),
            )
            for kind, owner, propagation in owners
        ]
        dependencies.append(
            dependency(
                boundary_ref,
                self._member_ref(members[(boundary.flow_id, boundary.entry_node_id)]),
                domain="flow",
                kind="flow.boundary-entry-reachability",
                propagation="required",
                message_key="impact.dependency.sceneBoundaryEntry",
                evidence=self._boundary_evidence(boundary, "entry_node_id"),
            )
        )
        dependencies.extend(
            dependency(
                boundary_ref,
                self._member_ref(members[(boundary.flow_id, node_id)]),
                domain="flow",
                kind="flow.boundary-exit-reachability",
                propagation="conditional",
                message_key="impact.dependency.sceneBoundaryExit",
                parameters={"order": order},
                evidence=self._boundary_evidence(boundary, "exit_node_ids", order=order),
            )
            for order, node_id in enumerate(boundary.exit_node_ids)
        )
        return tuple(dependencies)

    def _dialogue_dependencies(self, document: ProjectDocument) -> list[ImpactDependency]:
        dependencies: list[ImpactDependency] = []
        transitions_by_origin: dict[str, list[ProjectFlowTransitionRecord]] = {}
        for transition in document.flow_transitions:
            origin_id = transition.metadata.get("dialogue_element_id")
            if isinstance(origin_id, str):
                transitions_by_origin.setdefault(origin_id, []).append(transition)
        invocations = {item.id: item for item in document.flow_invocations}

        for owned in document.dialogues:
            dialogue_ref = resource_ref("node", owned.node_id)
            element_refs = self._dialogue_element_refs(owned)
            participant_refs = {
                node_id: resource_ref("dialogue_participant", node_id, context=dialogue_ref)
                for node_id in owned.document.participants
            }
            for order, participant_id in enumerate(owned.document.participants):
                participant_ref = participant_refs[participant_id]
                evidence = self._dialogue_evidence(
                    dialogue_ref,
                    "participants",
                    order=order,
                )
                dependencies.extend(
                    (
                        dependency(
                            resource_ref("node", participant_id),
                            participant_ref,
                            domain="dialogue",
                            kind="dialogue.participant-node",
                            propagation="required",
                            message_key="impact.dependency.dialogueParticipant",
                            evidence=evidence,
                        ),
                        dependency(
                            participant_ref,
                            dialogue_ref,
                            domain="dialogue",
                            kind="dialogue.participant-owner",
                            propagation="required",
                            message_key="impact.dependency.dialogueParticipant",
                            evidence=evidence,
                        ),
                    )
                )

            for order, element in enumerate(owned.document.elements):
                element_ref = element_refs[element.id]
                evidence = self._dialogue_evidence(
                    element_ref,
                    "elements",
                    order=order,
                )
                dependencies.append(
                    dependency(
                        dialogue_ref,
                        element_ref,
                        domain="dialogue",
                        kind="dialogue.element-owner",
                        propagation="required",
                        message_key="impact.dependency.dialogueElement",
                        evidence=evidence,
                    )
                )
                if owned.document.entry_element_id == element.id:
                    dependencies.append(
                        dependency(
                            dialogue_ref,
                            element_ref,
                            domain="dialogue",
                            kind="dialogue.entry-element",
                            propagation="required",
                            message_key="impact.dependency.dialogueEntry",
                            evidence=self._dialogue_evidence(dialogue_ref, "entry_element_id"),
                        )
                    )
                if isinstance(element, DialogueLineElement):
                    dependencies.append(
                        dependency(
                            participant_refs[element.speaker_node_id],
                            element_ref,
                            domain="dialogue",
                            kind="dialogue.line-speaker",
                            propagation="required",
                            message_key="impact.dependency.dialogueSpeaker",
                            evidence=self._dialogue_evidence(element_ref, "speaker_node_id"),
                        )
                    )
                    if element.next_element_id is not None:
                        dependencies.append(
                            self._dialogue_next_dependency(
                                element_ref,
                                element_refs[element.next_element_id],
                                conditional=False,
                            )
                        )
                elif isinstance(element, DialogueChoiceElement):
                    for option_order, option in enumerate(element.options):
                        option_ref = resource_ref(
                            "dialogue_option",
                            option.id,
                            context=element_ref,
                        )
                        dependencies.append(
                            dependency(
                                element_ref,
                                option_ref,
                                domain="dialogue",
                                kind="dialogue.option-owner",
                                propagation="required",
                                message_key="impact.dependency.dialogueOption",
                                parameters={"order": option_order},
                                evidence=self._dialogue_evidence(
                                    option_ref,
                                    "options",
                                    order=option_order,
                                ),
                            )
                        )
                        if option.next_element_id is not None:
                            dependencies.append(
                                self._dialogue_next_dependency(
                                    option_ref,
                                    element_refs[option.next_element_id],
                                    conditional=True,
                                )
                            )

            origin_refs = self._dialogue_origin_refs(owned)
            for edge in document.edges:
                origin_id = edge.metadata.get("dialogue_element_id")
                if edge.source_node_id != owned.node_id or origin_id not in origin_refs:
                    continue
                origin_ref = origin_refs[origin_id]
                dependencies.extend(self._dialogue_outcome_dependencies(origin_ref, edge))
                pointer = edge.metadata.get("outcome_flow_composition")
                if isinstance(pointer, dict):
                    invocation_id = pointer.get("invocation_id")
                    invocation = invocations.get(invocation_id)
                    if invocation is not None:
                        dependencies.append(
                            dependency(
                                origin_ref,
                                self._flow_record_ref(
                                    "flow_invocation",
                                    invocation.id,
                                    invocation.source_flow_id,
                                ),
                                domain="dialogue",
                                kind="dialogue.outcome-invocation",
                                propagation="required",
                                message_key="impact.dependency.dialogueOutcomeInvocation",
                                evidence=self._edge_evidence(edge, "outcome_flow_composition"),
                            )
                        )
            for origin_id, transitions in transitions_by_origin.items():
                origin_ref = origin_refs.get(origin_id)
                if origin_ref is None:
                    continue
                for transition in transitions:
                    dependencies.append(
                        dependency(
                            origin_ref,
                            self._flow_record_ref(
                                "flow_transition",
                                transition.id,
                                transition.flow_id,
                            ),
                            domain="dialogue",
                            kind="dialogue.outcome-transition",
                            propagation="required",
                            message_key="impact.dependency.dialogueOutcomeTransition",
                            evidence=self._transition_evidence(transition, "metadata.dialogue_element_id"),
                        )
                    )
        return dependencies

    def _quest_dependencies(self, document: ProjectDocument) -> list[ImpactDependency]:
        dependencies: list[ImpactDependency] = []
        transitions_by_branch: dict[str, list[ProjectFlowTransitionRecord]] = {}
        transitions_by_stage: dict[str, list[ProjectFlowTransitionRecord]] = {}
        for transition in document.flow_transitions:
            branch_id = transition.metadata.get("quest_branch_id")
            stage_id = transition.metadata.get("quest_stage_id")
            if isinstance(branch_id, str):
                transitions_by_branch.setdefault(branch_id, []).append(transition)
            if isinstance(stage_id, str):
                transitions_by_stage.setdefault(stage_id, []).append(transition)

        for owned in document.quests:
            quest_ref = resource_ref("node", owned.node_id)
            stage_refs = {
                stage.id: resource_ref("quest_stage", stage.id, context=quest_ref)
                for stage in owned.document.stages
            }
            branch_refs = {
                branch.id: resource_ref("quest_branch", branch.id, context=stage_refs[stage.id])
                for stage in owned.document.stages
                for branch in stage.branches
            }
            if owned.document.quest_giver_node_id is not None:
                giver_ref = resource_ref(
                    "quest_giver",
                    owned.document.quest_giver_node_id,
                    context=quest_ref,
                )
                evidence = self._quest_evidence(quest_ref, "quest_giver_node_id")
                dependencies.extend(
                    (
                        dependency(
                            resource_ref("node", owned.document.quest_giver_node_id),
                            giver_ref,
                            domain="quest",
                            kind="quest.giver-node",
                            propagation="required",
                            message_key="impact.dependency.questGiver",
                            evidence=evidence,
                        ),
                        dependency(
                            giver_ref,
                            quest_ref,
                            domain="quest",
                            kind="quest.giver-owner",
                            propagation="required",
                            message_key="impact.dependency.questGiver",
                            evidence=evidence,
                        ),
                    )
                )
            dependencies.extend(
                self._quest_reference_dependencies(
                    quest_ref,
                    "quest_requirement",
                    "quest.requirement",
                    "impact.dependency.questRequirement",
                    owned.document.prerequisite_node_ids,
                    "prerequisite_node_ids",
                )
            )
            dependencies.extend(
                self._quest_reference_dependencies(
                    quest_ref,
                    "quest_reward",
                    "quest.reward",
                    "impact.dependency.questReward",
                    owned.document.reward_node_ids,
                    "reward_node_ids",
                )
            )
            for stage_order, stage in enumerate(owned.document.stages):
                stage_ref = stage_refs[stage.id]
                dependencies.append(
                    dependency(
                        quest_ref,
                        stage_ref,
                        domain="quest",
                        kind="quest.stage-owner",
                        propagation="required",
                        message_key="impact.dependency.questStage",
                        parameters={"order": stage_order},
                        evidence=self._quest_evidence(stage_ref, "stages", order=stage_order),
                    )
                )
                if owned.document.entry_stage_id == stage.id:
                    dependencies.append(
                        dependency(
                            quest_ref,
                            stage_ref,
                            domain="quest",
                            kind="quest.entry-stage",
                            propagation="required",
                            message_key="impact.dependency.questEntry",
                            evidence=self._quest_evidence(quest_ref, "entry_stage_id"),
                        )
                    )
                for branch_order, branch in enumerate(stage.branches):
                    branch_ref = branch_refs[branch.id]
                    dependencies.append(
                        dependency(
                            stage_ref,
                            branch_ref,
                            domain="quest",
                            kind="quest.branch-owner",
                            propagation="required",
                            message_key="impact.dependency.questBranch",
                            parameters={"order": branch_order},
                            evidence=self._quest_evidence(
                                branch_ref,
                                "branches",
                                order=branch_order,
                            ),
                        )
                    )
                    if branch.target_stage_id is not None:
                        dependencies.append(
                            dependency(
                                branch_ref,
                                stage_refs[branch.target_stage_id],
                                domain="quest",
                                kind="quest.branch-reachability",
                                propagation="conditional",
                                message_key="impact.dependency.questBranchTarget",
                                evidence=self._quest_evidence(branch_ref, "target_stage_id"),
                            )
                        )

            for edge in document.edges:
                if edge.source_node_id != owned.node_id:
                    continue
                branch_id = edge.metadata.get("quest_branch_id")
                stage_id = edge.metadata.get("quest_stage_id")
                origin_ref = (
                    branch_refs.get(branch_id)
                    if isinstance(branch_id, str)
                    else stage_refs.get(stage_id) if isinstance(stage_id, str) else None
                )
                if origin_ref is not None:
                    dependencies.extend(self._quest_outcome_dependencies(origin_ref, edge))

            for branch_id, transitions in transitions_by_branch.items():
                origin_ref = branch_refs.get(branch_id)
                if origin_ref is not None:
                    dependencies.extend(
                        self._quest_transition_dependencies(origin_ref, transition)
                        for transition in transitions
                    )
            for stage_id, transitions in transitions_by_stage.items():
                origin_ref = stage_refs.get(stage_id)
                if origin_ref is None:
                    continue
                for transition in transitions:
                    branch_id = transition.metadata.get("quest_branch_id")
                    if isinstance(branch_id, str) and branch_id in branch_refs:
                        continue
                    dependencies.append(self._quest_transition_dependencies(origin_ref, transition))
        return dependencies

    def _quest_reference_dependencies(
        self,
        quest_ref: ImpactResourceRef,
        owner_type: str,
        kind_prefix: str,
        message_key: str,
        node_ids: list[str],
        field_path: str,
    ) -> tuple[ImpactDependency, ...]:
        dependencies: list[ImpactDependency] = []
        for order, node_id in enumerate(node_ids):
            reference_ref = resource_ref(owner_type, node_id, context=quest_ref)
            evidence = self._quest_evidence(quest_ref, field_path, order=order)
            dependencies.extend(
                (
                    dependency(
                        resource_ref("node", node_id),
                        reference_ref,
                        domain="quest",
                        kind=f"{kind_prefix}-node",
                        propagation="required",
                        message_key=message_key,
                        parameters={"order": order},
                        evidence=evidence,
                    ),
                    dependency(
                        reference_ref,
                        quest_ref,
                        domain="quest",
                        kind=f"{kind_prefix}-owner",
                        propagation="required",
                        message_key=message_key,
                        parameters={"order": order},
                        evidence=evidence,
                    ),
                )
            )
        return tuple(dependencies)

    @staticmethod
    def _dialogue_next_dependency(
        source: ImpactResourceRef,
        target: ImpactResourceRef,
        *,
        conditional: bool,
    ) -> ImpactDependency:
        return dependency(
            source,
            target,
            domain="dialogue",
            kind="dialogue.next-element",
            propagation="conditional" if conditional else "required",
            message_key="impact.dependency.dialogueNext",
            evidence=evidence_ref(
                source,
                field_path="next_element_id",
                message_key="impact.evidence.dialogue",
            ),
        )

    @staticmethod
    def _dialogue_outcome_dependencies(
        origin: ImpactResourceRef,
        edge: ProjectEdgeRecord,
    ) -> tuple[ImpactDependency, ...]:
        edge_ref = resource_ref("edge", edge.id)
        evidence = NarrativeStructureDependencyProjector._edge_evidence(
            edge,
            "metadata.dialogue_element_id",
        )
        return (
            dependency(
                origin,
                edge_ref,
                domain="dialogue",
                kind="dialogue.external-outcome",
                propagation="required",
                message_key="impact.dependency.dialogueOutcome",
                evidence=evidence,
            ),
            dependency(
                edge_ref,
                resource_ref("node", edge.target_node_id),
                domain="dialogue",
                kind="dialogue.outcome-target",
                propagation="conditional",
                message_key="impact.dependency.dialogueOutcomeTarget",
                evidence=evidence,
            ),
        )

    @staticmethod
    def _quest_outcome_dependencies(
        origin: ImpactResourceRef,
        edge: ProjectEdgeRecord,
    ) -> tuple[ImpactDependency, ...]:
        edge_ref = resource_ref("edge", edge.id)
        evidence = NarrativeStructureDependencyProjector._edge_evidence(edge, "metadata")
        return (
            dependency(
                origin,
                edge_ref,
                domain="quest",
                kind="quest.external-outcome",
                propagation="required",
                message_key="impact.dependency.questOutcome",
                evidence=evidence,
            ),
            dependency(
                edge_ref,
                resource_ref("node", edge.target_node_id),
                domain="quest",
                kind="quest.outcome-target",
                propagation="conditional",
                message_key="impact.dependency.questOutcomeTarget",
                evidence=evidence,
            ),
        )

    def _quest_transition_dependencies(
        self,
        origin: ImpactResourceRef,
        transition: ProjectFlowTransitionRecord,
    ) -> ImpactDependency:
        return dependency(
            origin,
            self._flow_record_ref("flow_transition", transition.id, transition.flow_id),
            domain="quest",
            kind="quest.outcome-transition",
            propagation="required",
            message_key="impact.dependency.questOutcomeTransition",
            evidence=self._transition_evidence(transition, "metadata"),
        )

    @staticmethod
    def _dialogue_resources(owned: OwnedDialogueDocument) -> list[ImpactResourceRef]:
        dialogue_ref = resource_ref("node", owned.node_id)
        resources = [
            *(
                resource_ref("dialogue_participant", node_id, context=dialogue_ref)
                for node_id in owned.document.participants
            ),
        ]
        for element in owned.document.elements:
            element_ref = resource_ref("dialogue_element", element.id, context=dialogue_ref)
            resources.append(element_ref)
            if isinstance(element, DialogueChoiceElement):
                resources.extend(
                    resource_ref("dialogue_option", option.id, context=element_ref)
                    for option in element.options
                )
        return resources

    @staticmethod
    def _quest_resources(owned: OwnedQuestDocument) -> list[ImpactResourceRef]:
        quest_ref = resource_ref("node", owned.node_id)
        resources = [
            *(
                resource_ref("quest_requirement", node_id, context=quest_ref)
                for node_id in owned.document.prerequisite_node_ids
            ),
            *(
                resource_ref("quest_reward", node_id, context=quest_ref)
                for node_id in owned.document.reward_node_ids
            ),
        ]
        if owned.document.quest_giver_node_id is not None:
            resources.append(
                resource_ref(
                    "quest_giver",
                    owned.document.quest_giver_node_id,
                    context=quest_ref,
                )
            )
        for stage in owned.document.stages:
            stage_ref = resource_ref("quest_stage", stage.id, context=quest_ref)
            resources.append(stage_ref)
            resources.extend(
                resource_ref("quest_branch", branch.id, context=stage_ref)
                for branch in stage.branches
            )
        return resources

    @staticmethod
    def _dialogue_element_refs(
        owned: OwnedDialogueDocument,
    ) -> dict[str, ImpactResourceRef]:
        dialogue_ref = resource_ref("node", owned.node_id)
        return {
            element.id: resource_ref("dialogue_element", element.id, context=dialogue_ref)
            for element in owned.document.elements
        }

    @staticmethod
    def _dialogue_origin_refs(
        owned: OwnedDialogueDocument,
    ) -> dict[str, ImpactResourceRef]:
        result = NarrativeStructureDependencyProjector._dialogue_element_refs(owned)
        for element in owned.document.elements:
            if not isinstance(element, DialogueChoiceElement):
                continue
            element_ref = result[element.id]
            result.update(
                {
                    option.id: resource_ref("dialogue_option", option.id, context=element_ref)
                    for option in element.options
                }
            )
        return result

    @staticmethod
    def _member_ref(member: ProjectStoryFlowNodeRecord) -> ImpactResourceRef:
        return resource_ref(
            "flow_member",
            member.id,
            context=resource_ref("flow", member.flow_id),
        )

    @staticmethod
    def _flow_record_ref(
        owner_type: str,
        owner_id: str,
        flow_id: str,
    ) -> ImpactResourceRef:
        return resource_ref(owner_type, owner_id, context=resource_ref("flow", flow_id))

    @staticmethod
    def _flow_marker_ref(owner_type: str, node_id: str, flow_id: str) -> ImpactResourceRef:
        return resource_ref(owner_type, node_id, context=resource_ref("flow", flow_id))

    @staticmethod
    def _flow_evidence(
        owner: ImpactResourceRef,
        field_path: str | None,
        **parameters: Any,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            owner,
            field_path=field_path,
            message_key="impact.evidence.flow",
            parameters=parameters,
        )

    @staticmethod
    def _transition_evidence(
        record: ProjectFlowTransitionRecord,
        field_path: str,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            NarrativeStructureDependencyProjector._flow_record_ref(
                "flow_transition",
                record.id,
                record.flow_id,
            ),
            field_path=field_path,
            message_key="impact.evidence.flowTransition",
            parameters={"priority": record.priority, "kind": record.kind},
            excerpt=record.label or None,
        )

    @staticmethod
    def _invocation_evidence(
        record: ProjectFlowInvocationRecord,
        field_path: str,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            NarrativeStructureDependencyProjector._flow_record_ref(
                "flow_invocation",
                record.id,
                record.source_flow_id,
            ),
            field_path=field_path,
            message_key="impact.evidence.flowInvocation",
            parameters={"priority": record.priority},
            excerpt=record.label or None,
        )

    @staticmethod
    def _exit_evidence(
        record: ProjectFlowExitRecord,
        field_path: str,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            NarrativeStructureDependencyProjector._flow_record_ref(
                "flow_exit",
                record.id,
                record.flow_id,
            ),
            field_path=field_path,
            message_key="impact.evidence.flowExit",
            parameters={"key": record.key},
            excerpt=record.label or None,
        )

    @staticmethod
    def _binding_evidence(
        record: ProjectFlowExitBindingRecord,
        field_path: str,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            resource_ref("flow_exit_binding", record.id),
            field_path=field_path,
            message_key="impact.evidence.flowBinding",
        )

    @staticmethod
    def _boundary_evidence(
        record: ProjectSceneFlowBoundaryRecord,
        field_path: str,
        **parameters: Any,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            NarrativeStructureDependencyProjector._flow_record_ref(
                "scene_boundary",
                record.id,
                record.flow_id,
            ),
            field_path=field_path,
            message_key="impact.evidence.sceneBoundary",
            parameters=parameters,
        )

    @staticmethod
    def _dialogue_evidence(
        owner: ImpactResourceRef,
        field_path: str,
        **parameters: Any,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            owner,
            field_path=field_path,
            message_key="impact.evidence.dialogue",
            parameters=parameters,
        )

    @staticmethod
    def _quest_evidence(
        owner: ImpactResourceRef,
        field_path: str,
        **parameters: Any,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            owner,
            field_path=field_path,
            message_key="impact.evidence.quest",
            parameters=parameters,
        )

    @staticmethod
    def _edge_evidence(
        record: ProjectEdgeRecord,
        field_path: str,
    ) -> ImpactEvidenceRef:
        return evidence_ref(
            resource_ref("edge", record.id),
            field_path=field_path,
            message_key="impact.evidence.narrativeOutcome",
            parameters={"relationship_type": record.type},
            excerpt=record.label or None,
        )


def _execution_propagation(
    *,
    condition: str,
    kind: str,
    is_default: bool,
) -> ImpactPropagation:
    if not condition and (kind == "next" or is_default):
        return "required"
    return "conditional"
