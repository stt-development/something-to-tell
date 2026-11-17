from dataclasses import replace

from pydantic import ValidationError

from ..domain.entities import EdgeEntity, NodeEntity
from ..engine_tags.automatic import (
    add_node_with_automatic_tag,
    add_relationship_with_automatic_tag,
    ensure_dialogue_engine_tags,
)
from ..repositories.interfaces import UnitOfWork
from ..schemas.resource_presenters import edge_response, node_response
from ..schemas.dialogue import DialogueDocument, DialogueLineElement
from ..schemas.dialogue_transition import (
    DialogueTransitionCreate,
    DialogueTransitionResponse,
    DialogueTransitionUpdate,
)
from .service import DIALOGUE_METADATA_KEY, DialogueService, DialogueServiceError

DIALOGUE_ORIGIN_METADATA_KEY = "dialogue_element_id"
OUTCOME_FLOW_COMPOSITION_METADATA_KEY = "outcome_flow_composition"


class DialogueTransitionService:
    """Owns atomic creation and validation of Dialogue-origin graph edges."""

    def create(self, uow: UnitOfWork, payload: DialogueTransitionCreate) -> DialogueTransitionResponse:
        dialogue = self._dialogue_node(uow, payload.dialogue_node_id)
        document = payload.dialogue_document or self._stored_document(dialogue)
        DialogueService().validate_document(uow, dialogue, document)
        self._require_origin(document, payload.dialogue_element_id)
        if payload.target_node_id is not None:
            target = self._target_node(uow, dialogue, payload.target_node_id)
        else:
            assert payload.new_target is not None
            target = NodeEntity(project_id=dialogue.project_id, **payload.new_target.model_dump())

        try:
            if payload.dialogue_document is not None:
                dialogue = uow.nodes.update(
                    replace(dialogue, metadata={**dialogue.metadata, DIALOGUE_METADATA_KEY: document.model_dump(mode="json")})
                )
                ensure_dialogue_engine_tags(uow, dialogue, document)
            if payload.new_target is not None:
                target = add_node_with_automatic_tag(uow, target)
            edge = add_relationship_with_automatic_tag(
                uow,
                EdgeEntity(
                    project_id=dialogue.project_id,
                    source_node_id=dialogue.id,
                    target_node_id=target.id,
                    type=payload.relationship_type,
                    label=payload.label,
                    condition=payload.condition,
                    metadata={DIALOGUE_ORIGIN_METADATA_KEY: payload.dialogue_element_id},
                ),
            )
            uow.commit()
        except Exception:
            # A flushed new target and edge still belong to one transaction until this commit.
            uow.rollback()
            raise
        return DialogueTransitionResponse(edge=edge_response(edge), target_node=node_response(target))

    def update(self, uow: UnitOfWork, edge_id: str, payload: DialogueTransitionUpdate) -> DialogueTransitionResponse:
        edge = uow.edges.get(edge_id)
        if edge is None:
            raise DialogueServiceError("dialogue_transition_not_found", f"Dialogue transition not found: {edge_id}")
        dialogue, document = self._dialogue_and_document(uow, edge.source_node_id)
        if edge.metadata.get(DIALOGUE_ORIGIN_METADATA_KEY) is None:
            raise DialogueServiceError("edge_is_not_dialogue_transition", f"Edge is not a Dialogue transition: {edge_id}")
        self._require_origin(document, payload.dialogue_element_id)
        target = self._target_node(uow, dialogue, payload.target_node_id)
        metadata = {**edge.metadata, DIALOGUE_ORIGIN_METADATA_KEY: payload.dialogue_element_id}
        if payload.outcome_flow_composition is None:
            metadata.pop(OUTCOME_FLOW_COMPOSITION_METADATA_KEY, None)
        else:
            metadata[OUTCOME_FLOW_COMPOSITION_METADATA_KEY] = payload.outcome_flow_composition.model_dump(mode="json")
        updated = uow.edges.update(
            replace(
                edge,
                project_id=dialogue.project_id,
                target_node_id=target.id,
                type=payload.relationship_type,
                label=payload.label,
                condition=payload.condition,
                metadata=metadata,
            )
        )
        uow.commit()
        return DialogueTransitionResponse(edge=edge_response(updated), target_node=node_response(target))

    def _dialogue_and_document(self, uow: UnitOfWork, node_id: str) -> tuple[NodeEntity, DialogueDocument]:
        dialogue = self._dialogue_node(uow, node_id)
        return dialogue, self._stored_document(dialogue)

    def _dialogue_node(self, uow: UnitOfWork, node_id: str) -> NodeEntity:
        dialogue = uow.nodes.get(node_id)
        if dialogue is None:
            raise DialogueServiceError("dialogue_node_not_found", f"Dialogue node not found: {node_id}")
        if dialogue.type != "Dialogue":
            raise DialogueServiceError("node_is_not_dialogue", f"Node is not a Dialogue node: {node_id}")
        return dialogue

    def _stored_document(self, dialogue: NodeEntity) -> DialogueDocument:
        stored = dialogue.metadata.get(DIALOGUE_METADATA_KEY)
        if stored is None:
            raise DialogueServiceError("dialogue_origin_not_found", "An empty Dialogue has no transition origins")
        try:
            return DialogueDocument.model_validate(stored)
        except ValidationError as error:
            raise DialogueServiceError(
                "dialogue_stored_document_invalid",
                f"Stored dialogue document is invalid: {dialogue.id}",
            ) from error

    def _require_origin(self, document: DialogueDocument, origin_id: str) -> None:
        # Only spoken lines and authored answers can own external outcomes;
        # Choice containers remain internal routing structure.
        origins = {
            origin
            for element in document.elements
            for origin in (
                [element.id]
                if isinstance(element, DialogueLineElement)
                else [option.id for option in element.options]
            )
        }
        if origin_id not in origins:
            raise DialogueServiceError("dialogue_origin_not_found", f"Dialogue transition origin not found: {origin_id}")

    def _target_node(self, uow: UnitOfWork, dialogue: NodeEntity, target_id: str) -> NodeEntity:
        target = uow.nodes.get(target_id)
        if target is None:
            raise DialogueServiceError("dialogue_transition_target_not_found", f"Transition target not found: {target_id}")
        if target.project_id != dialogue.project_id:
            raise DialogueServiceError("dialogue_cross_project_transition", f"Transition target belongs to another project: {target_id}")
        if target.id == dialogue.id:
            raise DialogueServiceError("dialogue_transition_self_target", "Dialogue transition cannot target its owning Dialogue node")
        return target
