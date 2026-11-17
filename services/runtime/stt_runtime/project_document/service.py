from dataclasses import replace
from datetime import datetime
from typing import Any, TypeVar

from pydantic import BaseModel

from ..dialogue.service import DIALOGUE_METADATA_KEY
from ..domain.entities import (
    AgentMemoryEntity,
    EdgeEntity,
    EngineTagEntity,
    EngineTagBindingEntity,
    EngineTagDefinitionEntity,
    FlowExitBindingEntity,
    FlowExitEntity,
    FlowInvocationEntity,
    FlowInitialStateEntity,
    FlowTransitionEntity,
    IssueEntity,
    NodeEntity,
    NarrativeEffectBindingEntity,
    NarrativeEffectEntity,
    ProjectEntity,
    SceneFlowBoundaryEntity,
    SceneStyleAssignmentEntity,
    StyleProfileEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    SuggestionEntity,
    VisualPlacementEntity,
)
from ..project_format.manifest import ProjectManifestV2
from ..quest.service import QUEST_METADATA_KEY
from ..repositories.interfaces import BatchAddRepository, UnitOfWork
from ..schemas.dialogue import DialogueDocument
from ..schemas.agent_memory import AgentMemoryEntryV1
from ..schemas.engine_tags import EngineTagBindingV1, EngineTagDefinitionV1, LegacyEngineTagRecordV1
from ..schemas.project_document import (
    OwnedDialogueDocument,
    OwnedQuestDocument,
    ProjectDocument,
    ProjectEdgeRecord,
    ProjectEngineTagRecord,
    ProjectFlowExitBindingRecord,
    ProjectFlowExitRecord,
    ProjectFlowInvocationRecord,
    ProjectFlowInitialStateRecord,
    ProjectFlowTransitionRecord,
    ProjectIssueRecord,
    ProjectNodeRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
    ProjectPlacementRecord,
    ProjectSceneFlowBoundaryRecord,
    ProjectStoryFlowNodeRecord,
    ProjectStoryFlowRecord,
    ProjectSuggestionRecord,
    create_project_document,
)
from ..schemas.quest import QuestDocument
from ..schemas.style_system import SceneStyleAssignmentV1, StyleProfileV1

RecordT = TypeVar("RecordT", bound=BaseModel)


class ProjectDocumentError(ValueError):
    """Reports missing ownership or invalid persisted specialized documents."""


class ProjectDocumentService:
    """Loads and transactionally reconciles every durable project aggregate."""

    def load(self, uow: UnitOfWork, manifest: ProjectManifestV2) -> ProjectDocument:
        project = uow.projects.get(manifest.project_id)
        if project is None:
            raise ProjectDocumentError(f"Project not found: {manifest.project_id}")

        node_entities = sorted(
            uow.nodes.list(project_id=manifest.project_id),
            key=lambda item: item.id,
        )
        nodes: list[ProjectNodeRecord] = []
        dialogues: list[OwnedDialogueDocument] = []
        quests: list[OwnedQuestDocument] = []
        for node in node_entities:
            generic_metadata = dict(node.metadata)
            raw_dialogue = generic_metadata.pop(DIALOGUE_METADATA_KEY, None)
            raw_quest = generic_metadata.pop(QUEST_METADATA_KEY, None)
            nodes.append(
                ProjectNodeRecord.model_validate(
                    replace(node, metadata=generic_metadata),
                    from_attributes=True,
                )
            )
            if node.type == "Dialogue":
                dialogues.append(
                    OwnedDialogueDocument(
                        node_id=node.id,
                        document=DialogueDocument.model_validate(raw_dialogue or {}),
                    )
                )
            elif raw_dialogue is not None:
                raise ProjectDocumentError(
                    f"Non-Dialogue node contains dialogue_document: {node.id}"
                )
            if node.type == "Quest":
                quests.append(
                    OwnedQuestDocument(
                        node_id=node.id,
                        document=self._quest_document(node, raw_quest),
                    )
                )
            elif raw_quest is not None:
                raise ProjectDocumentError(f"Non-Quest node contains quest_document: {node.id}")

        return create_project_document(
            manifest=manifest,
            project_metadata=project.metadata,
            nodes=nodes,
            edges=self._records(
                ProjectEdgeRecord,
                uow.edges.list(project_id=manifest.project_id),
            ),
            issues=self._records(
                ProjectIssueRecord,
                uow.issues.list(project_id=manifest.project_id),
            ),
            suggestions=self._records(
                ProjectSuggestionRecord,
                uow.suggestions.list(project_id=manifest.project_id),
            ),
            engine_tags=self._records(
                ProjectEngineTagRecord,
                uow.engine_tags.list(project_id=manifest.project_id),
            ),
            engine_tag_definitions=self._load_engine_tag_definitions(uow, manifest.project_id),
            engine_tag_bindings=self._load_engine_tag_bindings(uow, manifest.project_id),
            legacy_engine_tags=self._load_legacy_engine_tags(uow, manifest.project_id),
            placements=self._records(
                ProjectPlacementRecord,
                uow.visual_placements.list(project_id=manifest.project_id),
            ),
            dialogues=dialogues,
            quests=quests,
            story_flows=self._records(
                ProjectStoryFlowRecord,
                uow.story_flows.list(project_id=manifest.project_id),
            ),
            story_flow_nodes=self._records(
                ProjectStoryFlowNodeRecord,
                uow.story_flow_nodes.list(project_id=manifest.project_id),
            ),
            flow_transitions=self._records(
                ProjectFlowTransitionRecord,
                uow.flow_transitions.list(project_id=manifest.project_id),
            ),
            scene_flow_boundaries=self._records(
                ProjectSceneFlowBoundaryRecord,
                uow.scene_flow_boundaries.list(project_id=manifest.project_id),
            ),
            flow_invocations=self._records(
                ProjectFlowInvocationRecord,
                uow.flow_invocations.list(project_id=manifest.project_id),
            ),
            flow_exits=self._records(
                ProjectFlowExitRecord,
                uow.flow_exits.list(project_id=manifest.project_id),
            ),
            flow_exit_bindings=self._records(
                ProjectFlowExitBindingRecord,
                uow.flow_exit_bindings.list(project_id=manifest.project_id),
            ),
            flow_initial_states=self._records(
                ProjectFlowInitialStateRecord,
                uow.flow_initial_states.list(project_id=manifest.project_id),
            ),
            narrative_effects=self._records(
                ProjectNarrativeEffectRecord,
                uow.narrative_effects.list(project_id=manifest.project_id),
            ),
            narrative_effect_bindings=self._records(
                ProjectNarrativeEffectBindingRecord,
                uow.narrative_effect_bindings.list(project_id=manifest.project_id),
            ),
            style_profiles=self._records(
                StyleProfileV1,
                uow.style_profiles.list(project_id=manifest.project_id),
            ),
            scene_style_assignments=self._records(
                SceneStyleAssignmentV1,
                uow.scene_style_assignments.list(project_id=manifest.project_id),
            ),
            agent_memories=self._records(
                AgentMemoryEntryV1,
                uow.agent_memories.list(project_id=manifest.project_id),
            ),
        )

    def reconcile(
        self,
        uow: UnitOfWork,
        document: ProjectDocument,
        *,
        commit: bool = True,
    ) -> ProjectDocument:
        # Revalidation catches documents built through model_copy/model_construct
        # before any destructive repository operation begins.
        validated = ProjectDocument.model_validate(document.model_dump(mode="json"))
        existing_project = uow.projects.get(validated.manifest.project_id)
        if existing_project is None:
            raise ProjectDocumentError(f"Project not found: {validated.manifest.project_id}")

        dialogue_by_node = {
            owned.node_id: owned.document.model_dump(mode="json")
            for owned in validated.dialogues
        }
        quest_by_node = {
            owned.node_id: owned.document.model_dump(mode="json")
            for owned in validated.quests
        }

        try:
            self._delete_existing_records(uow, validated.manifest.project_id)
            uow.projects.update(
                ProjectEntity(
                    id=existing_project.id,
                    name=validated.manifest.name,
                    path=existing_project.path,
                    format_version=validated.manifest.format_version,
                    metadata=validated.project_metadata,
                    created_at=validated.manifest.created_at,
                    updated_at=validated.manifest.updated_at,
                )
            )
            # Preserve dependency order for ordinary-add substitutes. The reviewed
            # Node batch also proves local JSON owners within this atomic group.
            ordinary_nodes: list[NodeEntity] = []
            specialized_nodes: list[NodeEntity] = []
            for record in sorted(validated.nodes, key=lambda item: (item.type in {"Dialogue", "Quest"}, item.id)):
                metadata = dict(record.metadata)
                if record.id in dialogue_by_node:
                    metadata[DIALOGUE_METADATA_KEY] = dialogue_by_node[record.id]
                if record.id in quest_by_node:
                    metadata[QUEST_METADATA_KEY] = quest_by_node[record.id]
                entity = NodeEntity(**record.model_dump(mode="python", exclude={"metadata"}), metadata=metadata)
                destination = specialized_nodes if record.type in {"Dialogue", "Quest"} else ordinary_nodes
                destination.append(entity)
            self._add_entities(uow.nodes, ordinary_nodes + specialized_nodes)
            self._add_records(uow.edges, EdgeEntity, validated.edges)
            self._add_records(uow.issues, IssueEntity, validated.issues)
            self._add_records(uow.suggestions, SuggestionEntity, validated.suggestions)
            self._add_records(uow.engine_tags, EngineTagEntity, validated.engine_tags)
            self._add_engine_tag_definitions(uow, validated.engine_tag_definitions)
            self._add_records(
                uow.visual_placements,
                VisualPlacementEntity,
                validated.placements,
            )
            self._add_records(uow.story_flows, StoryFlowEntity, validated.story_flows)
            self._add_records(
                uow.story_flow_nodes,
                StoryFlowNodeEntity,
                validated.story_flow_nodes,
            )
            self._add_records(
                uow.flow_transitions,
                FlowTransitionEntity,
                validated.flow_transitions,
            )
            self._add_records(
                uow.scene_flow_boundaries,
                SceneFlowBoundaryEntity,
                validated.scene_flow_boundaries,
            )
            self._add_records(
                uow.flow_invocations,
                FlowInvocationEntity,
                validated.flow_invocations,
            )
            self._add_records(uow.flow_exits, FlowExitEntity, validated.flow_exits)
            self._add_records(
                uow.flow_exit_bindings,
                FlowExitBindingEntity,
                validated.flow_exit_bindings,
            )
            self._add_records(
                uow.flow_initial_states,
                FlowInitialStateEntity,
                validated.flow_initial_states,
            )
            self._add_records(
                uow.narrative_effects,
                NarrativeEffectEntity,
                validated.narrative_effects,
            )
            self._add_records(
                uow.narrative_effect_bindings,
                NarrativeEffectBindingEntity,
                validated.narrative_effect_bindings,
            )
            self._add_records(
                uow.style_profiles,
                StyleProfileEntity,
                validated.style_profiles,
            )
            self._add_records(
                uow.scene_style_assignments,
                SceneStyleAssignmentEntity,
                validated.scene_style_assignments,
            )
            self._add_agent_memories(uow, validated.agent_memories)
            self._add_engine_tag_bindings(uow, validated.engine_tag_bindings)
            if commit:
                uow.commit()
        except Exception:
            uow.rollback()
            raise
        return self.load(uow, validated.manifest)

    @staticmethod
    def _delete_existing_records(uow: UnitOfWork, project_id: str) -> None:
        # Delete dependants before owners so the sequence also works when a
        # backend enforces foreign keys immediately instead of through cascades.
        repository_records = (
            (uow.agent_memories, uow.agent_memories.list(project_id=project_id)),
            (
                uow.scene_style_assignments,
                uow.scene_style_assignments.list(project_id=project_id),
            ),
            (uow.style_profiles, uow.style_profiles.list(project_id=project_id)),
            (
                uow.narrative_effect_bindings,
                uow.narrative_effect_bindings.list(project_id=project_id),
            ),
            (uow.narrative_effects, uow.narrative_effects.list(project_id=project_id)),
            (
                uow.flow_initial_states,
                uow.flow_initial_states.list(project_id=project_id),
            ),
            (uow.flow_exit_bindings, uow.flow_exit_bindings.list(project_id=project_id)),
            (uow.flow_exits, uow.flow_exits.list(project_id=project_id)),
            (uow.flow_invocations, uow.flow_invocations.list(project_id=project_id)),
            (uow.scene_flow_boundaries, uow.scene_flow_boundaries.list(project_id=project_id)),
            (uow.flow_transitions, uow.flow_transitions.list(project_id=project_id)),
            (uow.story_flow_nodes, uow.story_flow_nodes.list(project_id=project_id)),
            (uow.visual_placements, uow.visual_placements.list(project_id=project_id)),
            (uow.engine_tags, uow.engine_tags.list(project_id=project_id)),
            (uow.engine_tag_bindings, uow.engine_tag_bindings.list(project_id=project_id)),
            (uow.engine_tag_definitions, uow.engine_tag_definitions.list(project_id=project_id)),
            (uow.issues, uow.issues.list(project_id=project_id)),
            (uow.edges, uow.edges.list(project_id=project_id)),
            (uow.suggestions, uow.suggestions.list(project_id=project_id)),
            (uow.story_flows, uow.story_flows.list(project_id=project_id)),
            (uow.nodes, uow.nodes.list(project_id=project_id)),
        )
        for repository, records in repository_records:
            for record in records:
                repository.delete(record.id)

    @staticmethod
    def _records(
        record_type: type[RecordT],
        entities: Any,
    ) -> list[RecordT]:
        return sorted(
            (
                record_type.model_validate(entity, from_attributes=True)
                for entity in entities
            ),
            key=lambda record: str(record.id),
        )

    @staticmethod
    def _add_entities(repository: Any, entities: Any) -> None:
        # Capability is optional: domain services do not import SQLAlchemy or
        # require every repository substitute to implement a bulk operation.
        if isinstance(repository, BatchAddRepository):
            repository.add_many(entities)
        else:
            for entity in entities:
                repository.add(entity)

    @staticmethod
    def _add_records(repository: Any, entity_type: Any, records: Any) -> None:
        ProjectDocumentService._add_entities(
            repository, [entity_type(**record.model_dump(mode="python")) for record in records],
        )

    @staticmethod
    def _load_engine_tag_definitions(uow: UnitOfWork, project_id: str) -> list[EngineTagDefinitionV1]:
        return sorted(
            [
                EngineTagDefinitionV1(
                    tag_version=record.tag_version,
                    id=record.id,
                    project_id=record.project_id,
                    key=record.key,
                    normalized_key=record.normalized_key,
                    description=record.description,
                    status=record.status,
                    aliases=record.aliases,
                    created_at=record.created_at.isoformat(),
                    updated_at=record.updated_at.isoformat(),
                )
                for record in uow.engine_tag_definitions.list(project_id=project_id)
            ],
            key=lambda record: record.id,
        )

    @staticmethod
    def _load_engine_tag_bindings(uow: UnitOfWork, project_id: str) -> list[EngineTagBindingV1]:
        return sorted(
            [
                EngineTagBindingV1(
                    tag_version=record.tag_version,
                    id=record.id,
                    project_id=record.project_id,
                    definition_id=record.definition_id,
                    owner=record.owner,
                    value=record.value,
                    created_at=record.created_at.isoformat(),
                    updated_at=record.updated_at.isoformat(),
                )
                for record in uow.engine_tag_bindings.list(project_id=project_id)
            ],
            key=lambda record: record.id,
        )

    @staticmethod
    def _load_legacy_engine_tags(uow: UnitOfWork, project_id: str) -> list[LegacyEngineTagRecordV1]:
        return sorted(
            [
                LegacyEngineTagRecordV1(
                    id=record.id,
                    project_id=record.project_id,
                    created_at=record.created_at.isoformat(),
                    updated_at=record.updated_at.isoformat(),
                    target_type=record.target_type,
                    target_id=record.target_id,
                    engine=record.engine,
                    key=record.key,
                    value=record.value,
                    metadata=record.metadata,
                )
                for record in uow.legacy_engine_tags.list(project_id=project_id)
            ],
            key=lambda record: record.id,
        )

    @staticmethod
    def _add_engine_tag_definitions(uow: UnitOfWork, records: Any) -> None:
        entities = []
        for record in records:
            payload = record.model_dump(mode="python")
            payload["created_at"] = datetime.fromisoformat(payload["created_at"])
            payload["updated_at"] = datetime.fromisoformat(payload["updated_at"])
            entities.append(EngineTagDefinitionEntity(**payload))
        ProjectDocumentService._add_entities(uow.engine_tag_definitions, entities)

    @staticmethod
    def _add_engine_tag_bindings(uow: UnitOfWork, records: Any) -> None:
        entities = []
        for record in records:
            payload = record.model_dump(mode="python")
            payload["created_at"] = datetime.fromisoformat(payload["created_at"])
            payload["updated_at"] = datetime.fromisoformat(payload["updated_at"])
            payload["owner_key"] = ":".join(
                f"{key}={value}"
                for key, value in sorted(payload["owner"].items())
                if value is not None
            )
            entities.append(EngineTagBindingEntity(**payload))
        ProjectDocumentService._add_entities(uow.engine_tag_bindings, entities)

    @staticmethod
    def _add_agent_memories(
        uow: UnitOfWork,
        records: list[AgentMemoryEntryV1],
    ) -> None:
        """Insert superseded owners before successors without changing document order."""

        pending = {record.id: record for record in records}
        inserted: set[str] = set()
        while pending:
            ready = sorted(
                (
                    record
                    for record in pending.values()
                    if record.supersedes_id is None or record.supersedes_id in inserted
                ),
                key=lambda record: record.id,
            )
            if not ready:
                raise ProjectDocumentError("agent memory supersession order is invalid")
            ProjectDocumentService._add_entities(uow.agent_memories,
                [AgentMemoryEntity(**record.model_dump(mode="python")) for record in ready])
            for record in ready:
                inserted.add(record.id)
                pending.pop(record.id)

    @staticmethod
    def _quest_document(node: NodeEntity, raw: Any) -> QuestDocument:
        if raw is not None:
            return QuestDocument.model_validate(raw)
        stage_id = "stage-1"
        return QuestDocument(
            objective=node.summary or node.title,
            entry_stage_id=stage_id,
            stages=[
                {
                    "id": stage_id,
                    "title": node.title,
                    "description": node.summary,
                    "branches": [],
                }
            ],
        )
