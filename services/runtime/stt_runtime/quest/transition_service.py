from dataclasses import replace

from pydantic import ValidationError

from ..domain.entities import EdgeEntity, NodeEntity
from ..engine_tags.automatic import (
    add_node_with_automatic_tag,
    add_relationship_with_automatic_tag,
    ensure_quest_engine_tags,
)
from ..repositories.interfaces import UnitOfWork
from ..schemas.resource_presenters import edge_response, node_response
from ..schemas.quest import QuestDocument
from ..schemas.quest_transition import QuestTransitionCreate, QuestTransitionResponse, QuestTransitionUpdate
from .service import QUEST_METADATA_KEY, QuestService, QuestServiceError

QUEST_STAGE_METADATA_KEY = "quest_stage_id"
QUEST_BRANCH_METADATA_KEY = "quest_branch_id"
OUTCOME_FLOW_COMPOSITION_METADATA_KEY = "outcome_flow_composition"
SUPPORTED_TARGET_TYPES = {"Event", "Dialogue", "Consequence", "Scene", "Location", "Quest"}


class QuestTransitionService:
    """Owns atomic creation and validation of branch-origin graph edges."""

    def create(self, uow: UnitOfWork, payload: QuestTransitionCreate) -> QuestTransitionResponse:
        quest = QuestService().quest_node(uow, payload.quest_node_id)
        document = payload.quest_document or self._stored_document(quest)
        QuestService().validate_document(uow, quest, document)
        self._require_origin(document, payload.quest_stage_id, payload.quest_branch_id)
        if any(
            edge.source_node_id == quest.id
            and edge.metadata.get(QUEST_STAGE_METADATA_KEY) == payload.quest_stage_id
            and edge.metadata.get(QUEST_BRANCH_METADATA_KEY) == payload.quest_branch_id
            for edge in uow.edges.list(project_id=quest.project_id)
        ):
            raise QuestServiceError("quest_transition_origin_duplicate", f"Quest branch already has an external target: {payload.quest_branch_id}")
        if payload.target_node_id is not None:
            target = self._target_node(uow, quest, payload.target_node_id)
        else:
            assert payload.new_target is not None
            if payload.new_target.type not in SUPPORTED_TARGET_TYPES:
                raise QuestServiceError("quest_transition_target_kind_invalid", f"Unsupported Quest transition target: {payload.new_target.type}")
            target = NodeEntity(project_id=quest.project_id, **payload.new_target.model_dump())

        try:
            if payload.quest_document is not None:
                quest = uow.nodes.update(replace(quest, metadata={**quest.metadata, QUEST_METADATA_KEY: document.model_dump(mode="json")}))
                ensure_quest_engine_tags(uow, quest, document)
            if payload.new_target is not None:
                target = add_node_with_automatic_tag(uow, target)
            edge = add_relationship_with_automatic_tag(
                uow,
                EdgeEntity(
                    project_id=quest.project_id,
                    source_node_id=quest.id,
                    target_node_id=target.id,
                    type=payload.relationship_type,
                    label=payload.label,
                    condition=payload.condition,
                    metadata={QUEST_STAGE_METADATA_KEY: payload.quest_stage_id, QUEST_BRANCH_METADATA_KEY: payload.quest_branch_id},
                ),
            )
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return QuestTransitionResponse(edge=edge_response(edge), target_node=node_response(target))

    def update(self, uow: UnitOfWork, edge_id: str, payload: QuestTransitionUpdate) -> QuestTransitionResponse:
        edge = uow.edges.get(edge_id)
        if edge is None:
            raise QuestServiceError("quest_transition_not_found", f"Quest transition not found: {edge_id}")
        quest = QuestService().quest_node(uow, edge.source_node_id)
        document = self._stored_document(quest)
        if edge.metadata.get(QUEST_BRANCH_METADATA_KEY) is None:
            raise QuestServiceError("edge_is_not_quest_transition", f"Edge is not a Quest transition: {edge_id}")
        self._require_origin(document, payload.quest_stage_id, payload.quest_branch_id)
        target = self._target_node(uow, quest, payload.target_node_id)
        metadata = {
            **edge.metadata,
            QUEST_STAGE_METADATA_KEY: payload.quest_stage_id,
            QUEST_BRANCH_METADATA_KEY: payload.quest_branch_id,
        }
        if payload.outcome_flow_composition is None:
            metadata.pop(OUTCOME_FLOW_COMPOSITION_METADATA_KEY, None)
        else:
            metadata[OUTCOME_FLOW_COMPOSITION_METADATA_KEY] = payload.outcome_flow_composition.model_dump(mode="json")
        updated = uow.edges.update(replace(
            edge,
            target_node_id=target.id,
            type=payload.relationship_type,
            label=payload.label,
            condition=payload.condition,
            metadata=metadata,
        ))
        uow.commit()
        return QuestTransitionResponse(edge=edge_response(updated), target_node=node_response(target))

    @staticmethod
    def _stored_document(quest: NodeEntity) -> QuestDocument:
        stored = quest.metadata.get(QUEST_METADATA_KEY)
        if stored is None:
            raise QuestServiceError("quest_origin_not_found", "An uninitialized Quest has no transition origins")
        try:
            return QuestDocument.model_validate(stored)
        except ValidationError as error:
            raise QuestServiceError("quest_stored_document_invalid", f"Stored quest document is invalid: {quest.id}") from error

    @staticmethod
    def _require_origin(document: QuestDocument, stage_id: str, branch_id: str) -> None:
        for stage in document.stages:
            if stage.id != stage_id:
                continue
            for branch in stage.branches:
                if branch.id == branch_id:
                    if branch.target_stage_id is not None:
                        raise QuestServiceError("quest_origin_is_internal", f"Quest branch already targets an internal stage: {branch_id}")
                    return
        raise QuestServiceError("quest_origin_not_found", f"Quest transition origin not found: {stage_id}/{branch_id}")

    @staticmethod
    def _target_node(uow: UnitOfWork, quest: NodeEntity, target_id: str) -> NodeEntity:
        target = uow.nodes.get(target_id)
        if target is None:
            raise QuestServiceError("quest_transition_target_not_found", f"Quest transition target not found: {target_id}")
        if target.project_id != quest.project_id:
            raise QuestServiceError("quest_cross_project_transition", f"Quest transition target belongs to another project: {target_id}")
        if target.id == quest.id:
            raise QuestServiceError("quest_transition_self_target", "Quest transition cannot target its owning Quest node")
        if target.type not in SUPPORTED_TARGET_TYPES:
            raise QuestServiceError("quest_transition_target_kind_invalid", f"Unsupported Quest transition target: {target.type}")
        return target
