from dataclasses import replace

from pydantic import ValidationError

from ..domain.entities import NodeEntity
from ..engine_tags.automatic import ensure_quest_engine_tags
from ..repositories.interfaces import UnitOfWork
from ..schemas.quest import QuestDocument

QUEST_METADATA_KEY = "quest_document"


class QuestServiceError(ValueError):
    """Carries a stable Quest aggregate validation code to the API."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class QuestService:
    """Reads and atomically replaces validated documents owned by Quest nodes."""

    def get_document(self, uow: UnitOfWork, node_id: str) -> QuestDocument:
        node = self.quest_node(uow, node_id)
        stored = node.metadata.get(QUEST_METADATA_KEY)
        if stored is None:
            document = self._legacy_document(node)
            self.store_document(uow, node, document)
            return document
        try:
            return QuestDocument.model_validate(stored)
        except ValidationError as error:
            raise QuestServiceError("quest_stored_document_invalid", f"Stored quest document is invalid: {node_id}") from error

    def update_document(self, uow: UnitOfWork, node_id: str, document: QuestDocument) -> QuestDocument:
        node = self.quest_node(uow, node_id)
        self.validate_document(uow, node, document)
        self.store_document(uow, node, document)
        return document

    def validate_document(self, uow: UnitOfWork, node: NodeEntity, document: QuestDocument) -> None:
        """Validates canonical references and existing branch-owned graph edges."""
        if document.quest_giver_node_id is not None:
            self._require_reference(uow, node, document.quest_giver_node_id, "Character", "quest_giver")
        for prerequisite_id in document.prerequisite_node_ids:
            self._require_reference(uow, node, prerequisite_id, "Condition", "quest_prerequisite")
        for reward_id in document.reward_node_ids:
            self._require_reference(uow, node, reward_id, "Item", "quest_reward")

        origins = {(stage.id, branch.id) for stage in document.stages for branch in stage.branches}
        external_origin_counts: dict[tuple[str, str], int] = {}
        for edge in uow.edges.list(project_id=node.project_id):
            if edge.source_node_id != node.id:
                continue
            stage_id = edge.metadata.get("quest_stage_id")
            branch_id = edge.metadata.get("quest_branch_id")
            if isinstance(stage_id, str) and isinstance(branch_id, str) and (stage_id, branch_id) not in origins:
                raise QuestServiceError(
                    "quest_transition_origin_stale",
                    f"Delete or reassign transition {edge.id} before removing Quest branch {branch_id}",
                )
            if isinstance(stage_id, str) and isinstance(branch_id, str):
                origin = (stage_id, branch_id)
                external_origin_counts[origin] = external_origin_counts.get(origin, 0) + 1
                if external_origin_counts[origin] > 1:
                    raise QuestServiceError("quest_transition_origin_duplicate", f"Quest branch has multiple external targets: {branch_id}")
                target = uow.nodes.get(edge.target_node_id)
                if target is None or target.project_id != node.project_id:
                    raise QuestServiceError("quest_transition_target_not_found", f"Quest transition target is unavailable: {edge.target_node_id}")
                if target.type not in {"Event", "Dialogue", "Consequence", "Scene", "Location", "Quest"}:
                    raise QuestServiceError("quest_transition_target_kind_invalid", f"Unsupported Quest transition target: {target.type}")

    def store_document(self, uow: UnitOfWork, node: NodeEntity, document: QuestDocument) -> None:
        try:
            # Replace only the aggregate key so visual placement and generic metadata survive.
            uow.nodes.update(replace(node, metadata={**node.metadata, QUEST_METADATA_KEY: document.model_dump(mode="json")}))
            ensure_quest_engine_tags(uow, node, document)
            uow.commit()
        except Exception:
            # Aggregate content and its initial nested tags must become visible together.
            uow.rollback()
            raise

    def quest_node(self, uow: UnitOfWork, node_id: str) -> NodeEntity:
        node = uow.nodes.get(node_id)
        if node is None:
            raise QuestServiceError("quest_node_not_found", f"Quest node not found: {node_id}")
        if node.type != "Quest":
            raise QuestServiceError("node_is_not_quest", f"Node is not a Quest node: {node_id}")
        return node

    @staticmethod
    def _legacy_document(node: NodeEntity) -> QuestDocument:
        stage_id = "stage-1"
        return QuestDocument(
            objective=node.summary or node.title,
            entry_stage_id=stage_id,
            stages=[{"id": stage_id, "title": node.title, "description": node.summary, "branches": []}],
        )

    @staticmethod
    def _require_reference(
        uow: UnitOfWork,
        quest: NodeEntity,
        reference_id: str,
        expected_type: str,
        role: str,
    ) -> None:
        reference = uow.nodes.get(reference_id)
        if reference is None:
            raise QuestServiceError(f"{role}_not_found", f"Quest {role.replace('_', ' ')} not found: {reference_id}")
        if reference.project_id != quest.project_id:
            raise QuestServiceError(f"{role}_cross_project", f"Quest {role.replace('_', ' ')} belongs to another project: {reference_id}")
        if reference.type != expected_type:
            raise QuestServiceError(f"{role}_wrong_type", f"Quest {role.replace('_', ' ')} must be {expected_type}: {reference_id}")
