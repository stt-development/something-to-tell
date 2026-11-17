from dataclasses import replace

from pydantic import ValidationError

from ..domain.entities import NodeEntity
from ..engine_tags.automatic import ensure_dialogue_engine_tags
from ..repositories.interfaces import UnitOfWork
from ..schemas.dialogue import DialogueDocument, DialogueLineElement

DIALOGUE_METADATA_KEY = "dialogue_document"


class DialogueServiceError(ValueError):
    """Carries a stable code from dialogue aggregate validation to the API."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class DialogueService:
    """Reads and atomically replaces validated documents owned by Dialogue nodes."""

    def get_document(self, uow: UnitOfWork, node_id: str) -> DialogueDocument:
        node = self._dialogue_node(uow, node_id)
        stored = node.metadata.get(DIALOGUE_METADATA_KEY)
        if stored is None:
            document = DialogueDocument()
            self._store_document(uow, node, document)
            return document
        try:
            return DialogueDocument.model_validate(stored)
        except ValidationError as error:
            raise DialogueServiceError("dialogue_stored_document_invalid", f"Stored dialogue document is invalid: {node_id}") from error

    def update_document(self, uow: UnitOfWork, node_id: str, document: DialogueDocument) -> DialogueDocument:
        node = self._dialogue_node(uow, node_id)
        self.validate_document(uow, node, document)
        self._store_document(uow, node, document)
        return document

    def validate_document(self, uow: UnitOfWork, node: NodeEntity, document: DialogueDocument) -> None:
        """Validates project-owned references for services sharing the aggregate transaction."""
        self._validate_participants(uow, node, document)
        valid_origins = {
            origin
            for element in document.elements
            for origin in (
                [element.id]
                if isinstance(element, DialogueLineElement)
                else [option.id for option in element.options]
            )
        }
        for edge in uow.edges.list(project_id=node.project_id):
            origin = edge.metadata.get("dialogue_element_id") if edge.source_node_id == node.id else None
            if isinstance(origin, str) and origin not in valid_origins:
                raise DialogueServiceError(
                    "dialogue_transition_origin_stale",
                    f"Delete or reassign transition {edge.id} before removing its dialogue origin: {origin}",
                )

    def _store_document(self, uow: UnitOfWork, node: NodeEntity, document: DialogueDocument) -> None:
        try:
            # Replace only the owned metadata key so canvas position and external metadata survive.
            uow.nodes.update(replace(node, metadata={**node.metadata, DIALOGUE_METADATA_KEY: document.model_dump(mode="json")}))
            ensure_dialogue_engine_tags(uow, node, document)
            uow.commit()
        except Exception:
            # Aggregate content and its initial nested tags must become visible together.
            uow.rollback()
            raise

    def _dialogue_node(self, uow: UnitOfWork, node_id: str) -> NodeEntity:
        node = uow.nodes.get(node_id)
        if node is None:
            raise DialogueServiceError("dialogue_node_not_found", f"Dialogue node not found: {node_id}")
        if node.type != "Dialogue":
            raise DialogueServiceError("node_is_not_dialogue", f"Node is not a Dialogue node: {node_id}")
        return node

    def _validate_participants(self, uow: UnitOfWork, dialogue: NodeEntity, document: DialogueDocument) -> None:
        # Validate every participant before writing so a stale reference cannot partially persist.
        for participant_id in document.participants:
            participant = uow.nodes.get(participant_id)
            if participant is None:
                raise DialogueServiceError("dialogue_participant_not_found", f"Dialogue participant not found: {participant_id}")
            if participant.project_id != dialogue.project_id:
                raise DialogueServiceError(
                    "dialogue_cross_project_participant",
                    f"Dialogue participant belongs to another project: {participant_id}",
                )
            if participant.type != "Character":
                raise DialogueServiceError("dialogue_participant_not_character", f"Dialogue participant is not a Character: {participant_id}")
