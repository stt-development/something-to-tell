from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from pydantic import TypeAdapter, ValidationError

from ..domain.entities import (
    FlowInitialStateEntity,
    NarrativeEffectBindingEntity,
    NarrativeEffectEntity,
    utc_now,
)
from ..repositories.interfaces import UnitOfWork
from ..schemas.dialogue import DialogueDocument
from ..schemas.narrative_state import (
    FlowInitialState,
    ItemCustody,
    NarrativeEffectBinding,
    NarrativeEffectDefinition,
    NarrativeEffectOwnerRecordRef,
    NarrativeEffectOwnerRef,
    NarrativeStateCanonicalNodeRef,
    NarrativeStateContract,
    NarrativeStateFlowRef,
    StateHolderRef,
    TransferItemEffect,
)
from ..schemas.narrative_state_api import (
    FlowInitialStateResponse,
    FlowInitialStateWrite,
    NarrativeEffectBindingBatch,
    NarrativeEffectBindingResponse,
    NarrativeEffectBindingWrite,
    NarrativeEffectWrite,
    NarrativeStateDeletionImpact,
    NarrativeStateIntegrityFact,
    NarrativeStateIntegrityReport,
    NarrativeStateSnapshot,
    RelationshipInitialStateApply,
    RelationshipInitialStateApplyResponse,
    RelationshipInitialStatePreview,
    RelationshipInitialStatePreviewRequest,
)
from ..schemas.quest import QuestDocument


EFFECT_ADAPTER = TypeAdapter(NarrativeEffectDefinition)
DIALOGUE_METADATA_KEY = "dialogue_document"
QUEST_METADATA_KEY = "quest_document"


class NarrativeStateServiceError(RuntimeError):
    """Stable, localization-ready authoring failure raised before commit."""

    def __init__(self, code: str, message: str, **parameters: str | int) -> None:
        super().__init__(message)
        self.code = code
        self.parameters = parameters


class NarrativeStateAuthoringService:
    """Own revision-neutral validation and atomic Phase 3.11 state mutations."""

    def snapshot(self, uow: UnitOfWork, project_id: str) -> NarrativeStateSnapshot:
        self._require_project(uow, project_id)
        return NarrativeStateSnapshot(
            project_id=project_id,
            initial_states=[
                self._initial_state(item)
                for item in sorted(
                    uow.flow_initial_states.list(project_id=project_id),
                    key=lambda record: record.id,
                )
            ],
            effects=[
                self._effect(item)
                for item in sorted(
                    uow.narrative_effects.list(project_id=project_id),
                    key=lambda record: record.id,
                )
            ],
            bindings=[
                self._binding(item)
                for item in sorted(
                    uow.narrative_effect_bindings.list(project_id=project_id),
                    key=lambda record: (
                        record.owner_kind,
                        record.context_node_id or "",
                        record.owner_id,
                        record.application_order,
                        record.id,
                    ),
                )
            ],
            integrity=self.integrity(uow, project_id),
        )

    def upsert_initial_state(
        self, uow: UnitOfWork, payload: FlowInitialStateWrite
    ) -> FlowInitialStateResponse:
        existing = list(
            uow.flow_initial_states.list(
                project_id=payload.project_id, flow_id=payload.flow_id
            )
        )
        if len(existing) > 1:
            raise self._conflict("one Flow has multiple initial-state records")
        candidate = FlowInitialStateEntity(
            id=existing[0].id if existing else FlowInitialStateEntity(
                project_id=payload.project_id, flow_id=payload.flow_id
            ).id,
            project_id=payload.project_id,
            flow_id=payload.flow_id,
            flags=dict(payload.flags),
            item_custody=[item.model_dump(mode="json") for item in payload.item_custody],
            quest_statuses=dict(payload.quest_statuses),
            created_at=existing[0].created_at if existing else utc_now(),
            updated_at=utc_now(),
        )
        self._validate_candidate(uow, payload.project_id, initial_state=candidate)
        saved = (
            uow.flow_initial_states.update(candidate)
            if existing
            else uow.flow_initial_states.add(candidate)
        )
        uow.commit()
        return self._initial_state(saved)

    def delete_initial_state(
        self, uow: UnitOfWork, state_id: str, project_id: str
    ) -> None:
        self._require_initial_state(uow, state_id, project_id)
        uow.flow_initial_states.delete(state_id)
        uow.commit()

    def create_effect(
        self, uow: UnitOfWork, payload: NarrativeEffectWrite
    ) -> NarrativeEffectDefinition:
        if payload.effect.project_id != payload.project_id:
            raise self._project_mismatch()
        if uow.narrative_effects.get(payload.effect.id) is not None:
            raise self._conflict("effect id is already used", effect_id=payload.effect.id)
        candidate = self._effect_entity(payload.effect)
        self._validate_candidate(uow, payload.project_id, added_effect=candidate)
        saved = uow.narrative_effects.add(candidate)
        uow.commit()
        return self._effect(saved)

    def update_effect(
        self, uow: UnitOfWork, effect_id: str, payload: NarrativeEffectWrite
    ) -> NarrativeEffectDefinition:
        existing = self._require_effect(uow, effect_id, payload.project_id)
        if payload.effect.id != effect_id or payload.effect.project_id != payload.project_id:
            raise self._project_mismatch()
        candidate = replace(
            self._effect_entity(payload.effect),
            created_at=existing.created_at,
            updated_at=utc_now(),
        )
        self._validate_candidate(uow, payload.project_id, replaced_effect=candidate)
        saved = uow.narrative_effects.update(candidate)
        uow.commit()
        return self._effect(saved)

    def effect_impact(
        self, uow: UnitOfWork, effect_id: str
    ) -> NarrativeStateDeletionImpact:
        effect = self._require_effect(uow, effect_id)
        return NarrativeStateDeletionImpact(
            subject_kind="effect",
            subject_id=effect.id,
            effect_ids=[effect.id],
            binding_ids=sorted(
                binding.id
                for binding in uow.narrative_effect_bindings.list(
                    project_id=effect.project_id, effect_id=effect.id
                )
            ),
        )

    def delete_effect(
        self,
        uow: UnitOfWork,
        effect_id: str,
        project_id: str,
        *,
        impact_reviewed: bool,
    ) -> None:
        effect = self._require_effect(uow, effect_id, project_id)
        bindings = list(
            uow.narrative_effect_bindings.list(
                project_id=effect.project_id, effect_id=effect.id
            )
        )
        if bindings and not impact_reviewed:
            raise NarrativeStateServiceError(
                "narrative_state_delete_requires_review",
                "Review the effect deletion impact before deleting its bindings.",
                effect_id=effect.id,
                binding_count=len(bindings),
            )
        try:
            for binding in bindings:
                uow.narrative_effect_bindings.delete(binding.id)
            uow.narrative_effects.delete(effect.id)
            uow.commit()
        except Exception:
            # Definition and bindings form one deletion command on every backend.
            uow.rollback()
            raise

    def create_binding(
        self, uow: UnitOfWork, payload: NarrativeEffectBindingWrite
    ) -> NarrativeEffectBindingResponse:
        candidate = NarrativeEffectBindingEntity(
            project_id=payload.project_id,
            effect_id=payload.effect_id,
            owner_kind=payload.owner.owner_kind,
            owner_id=payload.owner.owner_id,
            context_node_id=payload.owner.context_node_id,
            application_order=payload.application_order,
        )
        self._validate_candidate(uow, payload.project_id, added_binding=candidate)
        saved = uow.narrative_effect_bindings.add(candidate)
        uow.commit()
        return self._binding(saved)

    def update_binding(
        self,
        uow: UnitOfWork,
        binding_id: str,
        payload: NarrativeEffectBindingWrite,
    ) -> NarrativeEffectBindingResponse:
        existing = self._require_binding(uow, binding_id, payload.project_id)
        candidate = replace(
            existing,
            effect_id=payload.effect_id,
            owner_kind=payload.owner.owner_kind,
            owner_id=payload.owner.owner_id,
            context_node_id=payload.owner.context_node_id,
            application_order=payload.application_order,
            updated_at=utc_now(),
        )
        self._validate_candidate(uow, payload.project_id, replaced_binding=candidate)
        saved = uow.narrative_effect_bindings.update(candidate)
        uow.commit()
        return self._binding(saved)

    def reorder_bindings(
        self, uow: UnitOfWork, payload: NarrativeEffectBindingBatch
    ) -> list[NarrativeEffectBindingResponse]:
        owner_key = self._owner_key(payload.owner)
        existing = [
            binding
            for binding in uow.narrative_effect_bindings.list(project_id=payload.project_id)
            if self._entity_owner_key(binding) == owner_key
        ]
        ids = [item.binding_id for item in payload.bindings]
        orders = [item.application_order for item in payload.bindings]
        if len(ids) != len(set(ids)) or set(ids) != {item.id for item in existing}:
            raise self._batch_invalid("batch must contain every binding for one owner exactly once")
        if sorted(orders) != list(range(len(existing))):
            raise self._batch_invalid("application orders must be contiguous from zero")
        by_id = {item.id: item for item in existing}
        candidates = [
            replace(
                by_id[item.binding_id],
                application_order=item.application_order,
                updated_at=utc_now(),
            )
            for item in payload.bindings
        ]
        self._validate_candidate(
            uow,
            payload.project_id,
            replacement_bindings=candidates,
            replaced_binding_ids=set(ids),
        )
        try:
            saved = [uow.narrative_effect_bindings.update(item) for item in candidates]
            uow.commit()
        except Exception:
            # A failed row must not leave a partially reordered temporal sequence.
            uow.rollback()
            raise
        return [self._binding(item) for item in sorted(saved, key=lambda item: item.application_order)]

    def delete_binding(self, uow: UnitOfWork, binding_id: str, project_id: str) -> None:
        self._require_binding(uow, binding_id, project_id)
        uow.narrative_effect_bindings.delete(binding_id)
        uow.commit()

    def owner_impact(
        self, uow: UnitOfWork, project_id: str, owner: NarrativeEffectOwnerRef
    ) -> NarrativeStateDeletionImpact:
        self._require_project(uow, project_id)
        key = self._owner_key(owner)
        bindings = [
            binding
            for binding in uow.narrative_effect_bindings.list(project_id=project_id)
            if self._entity_owner_key(binding) == key
        ]
        return NarrativeStateDeletionImpact(
            subject_kind="owner",
            subject_id="|".join(part or "" for part in key),
            effect_ids=sorted({item.effect_id for item in bindings}),
            binding_ids=sorted(item.id for item in bindings),
        )

    def relationship_preview(
        self, uow: UnitOfWork, payload: RelationshipInitialStatePreviewRequest
    ) -> RelationshipInitialStatePreview:
        self._require_project(uow, payload.project_id)
        flow = uow.story_flows.get(payload.flow_id)
        edge = uow.edges.get(payload.edge_id)
        if flow is None or flow.project_id != payload.project_id:
            raise self._missing("Flow", payload.flow_id)
        if edge is None or edge.project_id != payload.project_id or edge.type != "owns":
            raise NarrativeStateServiceError(
                "narrative_state_relationship_invalid",
                "The selected relationship must be a project-owned owns edge.",
                edge_id=payload.edge_id,
            )
        holder_node = uow.nodes.get(edge.source_node_id)
        item_node = uow.nodes.get(edge.target_node_id)
        holder_kinds = {"Character": "character", "Location": "location", "Faction": "faction"}
        if (
            holder_node is None
            or item_node is None
            or holder_node.project_id != payload.project_id
            or item_node.project_id != payload.project_id
            or holder_node.type not in holder_kinds
            or item_node.type != "Item"
        ):
            raise NarrativeStateServiceError(
                "narrative_state_relationship_invalid",
                "An owns import requires Character, Location, or Faction to own an Item.",
                edge_id=payload.edge_id,
            )
        custody = ItemCustody(
            item_node_id=item_node.id,
            holder=StateHolderRef(kind=holder_kinds[holder_node.type], node_id=holder_node.id),
        )
        states = list(
            uow.flow_initial_states.list(project_id=payload.project_id, flow_id=payload.flow_id)
        )
        existing = next(
            (
                ItemCustody.model_validate(item)
                for state in states
                for item in state.item_custody
                if item.get("item_node_id") == item_node.id
            ),
            None,
        )
        return RelationshipInitialStatePreview(
            project_id=payload.project_id,
            edge_id=edge.id,
            flow_id=flow.id,
            custody=custody,
            already_applied=existing == custody,
            conflict_holder=(
                existing.holder.model_dump(mode="json")
                if existing is not None and existing != custody
                else None
            ),
        )

    def apply_relationship(
        self, uow: UnitOfWork, payload: RelationshipInitialStateApply
    ) -> RelationshipInitialStateApplyResponse:
        preview = self.relationship_preview(
            uow,
            RelationshipInitialStatePreviewRequest(
                project_id=payload.project_id,
                edge_id=payload.edge_id,
                flow_id=payload.flow_id,
            ),
        )
        if not payload.impact_reviewed:
            raise NarrativeStateServiceError(
                "narrative_state_relationship_review_required",
                "Review the relationship conversion preview before applying it.",
                edge_id=payload.edge_id,
            )
        if preview.conflict_holder is not None:
            raise self._conflict(
                "the Item already has a different initial holder",
                edge_id=payload.edge_id,
            )
        states = list(
            uow.flow_initial_states.list(project_id=payload.project_id, flow_id=payload.flow_id)
        )
        if len(states) > 1:
            raise self._conflict("one Flow has multiple initial-state records")
        if preview.already_applied:
            return RelationshipInitialStateApplyResponse(
                changed=False, initial_state=self._initial_state(states[0])
            )
        existing = states[0] if states else None
        command = FlowInitialStateWrite(
            project_id=payload.project_id,
            expected_revision=payload.expected_revision,
            flow_id=payload.flow_id,
            flags=dict(existing.flags) if existing else {},
            item_custody=[
                *(
                    [ItemCustody.model_validate(item) for item in existing.item_custody]
                    if existing
                    else []
                ),
                preview.custody,
            ],
            quest_statuses=dict(existing.quest_statuses) if existing else {},
        )
        return RelationshipInitialStateApplyResponse(
            changed=True,
            initial_state=self.upsert_initial_state(uow, command),
        )

    def integrity(self, uow: UnitOfWork, project_id: str) -> NarrativeStateIntegrityReport:
        self._require_project(uow, project_id)
        bindings = list(uow.narrative_effect_bindings.list(project_id=project_id))
        bound_ids = {item.effect_id for item in bindings}
        initial_items = {
            item.get("item_node_id")
            for state in uow.flow_initial_states.list(project_id=project_id)
            for item in state.item_custody
        }
        facts: list[NarrativeStateIntegrityFact] = []
        for effect in sorted(uow.narrative_effects.list(project_id=project_id), key=lambda item: item.id):
            if effect.id not in bound_ids:
                facts.append(
                    NarrativeStateIntegrityFact(
                        code="narrative_state_unbound_effect",
                        level="warning",
                        effect_id=effect.id,
                        parameters={"effect_id": effect.id},
                    )
                )
            parsed = self._effect(effect)
            if isinstance(parsed, TransferItemEffect) and parsed.payload.item_node_id not in initial_items:
                facts.append(
                    NarrativeStateIntegrityFact(
                        code="narrative_state_transfer_item_uninitialized",
                        level="info",
                        effect_id=effect.id,
                        node_id=parsed.payload.item_node_id,
                        parameters={"item_node_id": parsed.payload.item_node_id},
                    )
                )
        return NarrativeStateIntegrityReport(project_id=project_id, facts=facts)

    def _validate_candidate(
        self,
        uow: UnitOfWork,
        project_id: str,
        *,
        initial_state: FlowInitialStateEntity | None = None,
        added_effect: NarrativeEffectEntity | None = None,
        replaced_effect: NarrativeEffectEntity | None = None,
        added_binding: NarrativeEffectBindingEntity | None = None,
        replaced_binding: NarrativeEffectBindingEntity | None = None,
        replacement_bindings: Sequence[NarrativeEffectBindingEntity] = (),
        replaced_binding_ids: set[str] | None = None,
    ) -> None:
        """Validate the complete candidate graph before any repository write occurs."""

        self._require_project(uow, project_id)
        states = list(uow.flow_initial_states.list(project_id=project_id))
        if initial_state is not None:
            states = [item for item in states if item.flow_id != initial_state.flow_id]
            states.append(initial_state)
        effects = list(uow.narrative_effects.list(project_id=project_id))
        if replaced_effect is not None:
            effects = [item for item in effects if item.id != replaced_effect.id]
            effects.append(replaced_effect)
        if added_effect is not None:
            effects.append(added_effect)
        bindings = list(uow.narrative_effect_bindings.list(project_id=project_id))
        excluded = replaced_binding_ids or set()
        if replaced_binding is not None:
            excluded = {*excluded, replaced_binding.id}
            replacement_bindings = (*replacement_bindings, replaced_binding)
        bindings = [item for item in bindings if item.id not in excluded]
        if added_binding is not None:
            bindings.append(added_binding)
        bindings.extend(replacement_bindings)
        try:
            NarrativeStateContract(
                project_id=project_id,
                canonical_nodes=[
                    NarrativeStateCanonicalNodeRef(
                        id=node.id, project_id=node.project_id, type=node.type
                    )
                    for node in uow.nodes.list(project_id=project_id)
                ],
                flows=[
                    NarrativeStateFlowRef(id=flow.id, project_id=flow.project_id)
                    for flow in uow.story_flows.list(project_id=project_id)
                ],
                owners=self._owners(uow, project_id),
                initial_states=[self._state_contract(item) for item in states],
                effects=[self._effect(item) for item in effects],
                bindings=[self._binding_contract(item) for item in bindings],
            )
        except (ValidationError, ValueError) as error:
            message = str(error)
            code = (
                "narrative_state_owner_missing"
                if "owner" in message and "missing" in message
                else "narrative_state_reference_invalid"
            )
            raise NarrativeStateServiceError(code, message) from error

    def _owners(
        self, uow: UnitOfWork, project_id: str
    ) -> list[NarrativeEffectOwnerRecordRef]:
        owners = [
            self._owner_record(project_id, "node_entry", node.id)
            for node in uow.nodes.list(project_id=project_id)
        ]
        owners.extend(
            self._owner_record(project_id, "flow_transition", item.id)
            for item in uow.flow_transitions.list(project_id=project_id)
        )
        for node in uow.nodes.list(project_id=project_id):
            if node.type == "Dialogue" and DIALOGUE_METADATA_KEY in node.metadata:
                document = DialogueDocument.model_validate(node.metadata[DIALOGUE_METADATA_KEY])
                for element in document.elements:
                    owners.append(self._owner_record(project_id, "dialogue_element", element.id, node.id))
                    owners.extend(
                        self._owner_record(project_id, "dialogue_option", option.id, node.id)
                        for option in getattr(element, "options", [])
                    )
            if node.type == "Quest" and QUEST_METADATA_KEY in node.metadata:
                document = QuestDocument.model_validate(node.metadata[QUEST_METADATA_KEY])
                for stage in document.stages:
                    for branch in stage.branches:
                        owners.append(self._owner_record(project_id, "quest_branch", branch.id, node.id))
                        if branch.target_stage_id is None:
                            owners.append(self._owner_record(project_id, "quest_outcome", branch.id, node.id))
        owners.extend(
            self._owner_record(project_id, "flow_invocation", item.id)
            for item in uow.flow_invocations.list(project_id=project_id)
        )
        owners.extend(
            self._owner_record(project_id, "flow_exit", item.id)
            for item in uow.flow_exits.list(project_id=project_id)
        )
        return owners

    @staticmethod
    def _owner_record(
        project_id: str, owner_kind: str, owner_id: str, context_node_id: str | None = None
    ) -> NarrativeEffectOwnerRecordRef:
        return NarrativeEffectOwnerRecordRef(
            project_id=project_id,
            owner=NarrativeEffectOwnerRef(
                owner_kind=owner_kind,
                owner_id=owner_id,
                context_node_id=context_node_id,
            ),
        )

    @staticmethod
    def _state_contract(entity: FlowInitialStateEntity) -> FlowInitialState:
        return FlowInitialState(
            project_id=entity.project_id,
            flow_id=entity.flow_id,
            flags=entity.flags,
            item_custody=entity.item_custody,
            quest_statuses=entity.quest_statuses,
        )

    @staticmethod
    def _effect_entity(effect: NarrativeEffectDefinition) -> NarrativeEffectEntity:
        data = effect.model_dump(mode="json")
        return NarrativeEffectEntity(
            id=data["id"],
            project_id=data["project_id"],
            operation=data["operation"],
            payload=data["payload"],
            explanation=data["explanation"],
            effect_version=data["effect_version"],
            repeat_policy=data["repeat_policy"],
        )

    @staticmethod
    def _effect(entity: NarrativeEffectEntity) -> NarrativeEffectDefinition:
        return EFFECT_ADAPTER.validate_python(
            {
                "id": entity.id,
                "project_id": entity.project_id,
                "operation": entity.operation,
                "payload": entity.payload,
                "explanation": entity.explanation,
                "effect_version": entity.effect_version,
                "repeat_policy": entity.repeat_policy,
            }
        )

    @staticmethod
    def _binding_contract(entity: NarrativeEffectBindingEntity) -> NarrativeEffectBinding:
        return NarrativeEffectBinding(
            id=entity.id,
            project_id=entity.project_id,
            effect_id=entity.effect_id,
            owner=NarrativeEffectOwnerRef(
                owner_kind=entity.owner_kind,
                owner_id=entity.owner_id,
                context_node_id=entity.context_node_id,
            ),
            application_order=entity.application_order,
        )

    @classmethod
    def _binding(cls, entity: NarrativeEffectBindingEntity) -> NarrativeEffectBindingResponse:
        contract = cls._binding_contract(entity)
        return NarrativeEffectBindingResponse(
            id=contract.id,
            project_id=contract.project_id,
            effect_id=contract.effect_id,
            owner=contract.owner,
            application_order=contract.application_order,
            created_at=entity.created_at,
            updated_at=entity.updated_at,
        )

    @staticmethod
    def _initial_state(entity: FlowInitialStateEntity) -> FlowInitialStateResponse:
        return FlowInitialStateResponse(
            id=entity.id,
            project_id=entity.project_id,
            flow_id=entity.flow_id,
            flags=entity.flags,
            item_custody=entity.item_custody,
            quest_statuses=entity.quest_statuses,
            created_at=entity.created_at,
            updated_at=entity.updated_at,
        )

    @staticmethod
    def _owner_key(owner: NarrativeEffectOwnerRef) -> tuple[str, str | None, str]:
        return owner.owner_kind, owner.context_node_id, owner.owner_id

    @staticmethod
    def _entity_owner_key(entity: NarrativeEffectBindingEntity) -> tuple[str, str | None, str]:
        return entity.owner_kind, entity.context_node_id, entity.owner_id

    @staticmethod
    def _require_project(uow: UnitOfWork, project_id: str) -> None:
        if uow.projects.get(project_id) is None:
            raise NarrativeStateServiceError(
                "narrative_state_project_not_found",
                f"Project not found: {project_id}",
                project_id=project_id,
            )

    def _require_initial_state(
        self, uow: UnitOfWork, state_id: str, project_id: str
    ) -> FlowInitialStateEntity:
        state = uow.flow_initial_states.get(state_id)
        if state is None or state.project_id != project_id:
            raise self._missing("initial state", state_id)
        return state

    def _require_effect(
        self, uow: UnitOfWork, effect_id: str, project_id: str | None = None
    ) -> NarrativeEffectEntity:
        effect = uow.narrative_effects.get(effect_id)
        if effect is None or (project_id is not None and effect.project_id != project_id):
            raise self._missing("effect", effect_id)
        return effect

    def _require_binding(
        self, uow: UnitOfWork, binding_id: str, project_id: str
    ) -> NarrativeEffectBindingEntity:
        binding = uow.narrative_effect_bindings.get(binding_id)
        if binding is None or binding.project_id != project_id:
            raise self._missing("binding", binding_id)
        return binding

    @staticmethod
    def _missing(label: str, record_id: str) -> NarrativeStateServiceError:
        return NarrativeStateServiceError(
            "narrative_state_record_not_found",
            f"{label.title()} not found: {record_id}",
            record_id=record_id,
        )

    @staticmethod
    def _project_mismatch() -> NarrativeStateServiceError:
        return NarrativeStateServiceError(
            "narrative_state_project_mismatch",
            "The command and nested record must belong to the same project.",
        )

    @staticmethod
    def _conflict(message: str, **parameters: str | int) -> NarrativeStateServiceError:
        return NarrativeStateServiceError("narrative_state_conflict", message, **parameters)

    @staticmethod
    def _batch_invalid(message: str) -> NarrativeStateServiceError:
        return NarrativeStateServiceError("narrative_state_batch_invalid", message)
