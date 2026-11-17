from collections.abc import Callable, Sequence
from dataclasses import fields
from datetime import UTC, datetime
from typing import Any, Generic, TypeVar

from sqlalchemy import select, update
from sqlalchemy.orm import Session
from sqlalchemy.exc import MultipleResultsFound

from ..db import models
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
    ImpactResolutionDecisionEntity,
    LegacyEngineTagEntity,
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
from .interfaces import (
    AgentMemoryRepository,
    EdgeRepository,
    EngineTagRepository,
    EngineTagBindingRepository,
    EngineTagDefinitionRepository,
    FlowExitBindingRepository,
    FlowExitRepository,
    FlowInvocationRepository,
    FlowInitialStateRepository,
    FlowTransitionRepository,
    IssueRepository,
    ImpactResolutionDecisionRepository,
    NodeRepository,
    LegacyEngineTagRepository,
    NarrativeEffectBindingRepository,
    NarrativeEffectRepository,
    ProjectRepository,
    SceneFlowBoundaryRepository,
    SceneStyleAssignmentRepository,
    StyleProfileRepository,
    StoryFlowNodeRepository,
    StoryFlowRepository,
    SuggestionRepository,
    UnitOfWork,
    VisualPlacementRepository,
)
from .project_scope import ProjectScopeError, require_project, scoped_statement, validate_delete, validate_entities, validate_entity

EntityT = TypeVar("EntityT")
ModelT = TypeVar("ModelT")


class EntityNotFoundError(LookupError):
    pass


def _entity_values(entity) -> dict[str, Any]:
    return {("metadata_" if field.name == "metadata" else field.name): getattr(entity, field.name)
            for field in fields(entity)}


class SqlAlchemyRepository(Generic[EntityT, ModelT]):
    def __init__(
        self,
        session: Session,
        model_type: type[ModelT],
        entity_type: type[EntityT],
        *,
        project_scoped: bool = True,
    ) -> None:
        self._session = session
        self._model_type = model_type
        self._entity_type = entity_type
        self._project_scoped = project_scoped

    def add(self, entity: EntityT) -> EntityT:
        model = self._model_from_entity(entity)
        self._session.add(model)
        self._session.flush()
        return self._entity_from_model(model)

    def add_many(self, entities: Sequence[EntityT]) -> Sequence[EntityT]:
        # Exact types only: inherited opt-ins must not bypass a custom validator.
        # Do not inspect temporarily wrapped methods (development SQL attribution).
        if type(self) not in _BATCH_ADD_REPOSITORIES:
            return [self.add(entity) for entity in entities]
        if not entities:
            return []
        validate_entities(self._session, self._model_type, entities)
        models_to_add = [self._model_type(**_entity_values(entity)) for entity in entities]
        self._session.add_all(models_to_add)
        self._session.flush()
        return [self._entity_from_model(model) for model in models_to_add]

    def get(self, entity_id: str) -> EntityT | None:
        model = self._get_model(entity_id)
        return self._entity_from_model(model) if model is not None else None

    def _get_model(self, entity_id: str, *, project_id: str | None = None) -> ModelT | None:
        statement = select(self._model_type).where(self._model_type.id == entity_id)
        if project_id is not None and self._project_scoped:
            self._require_project(project_id)
            statement = statement.where(self._model_type.project_id == project_id)
        return self._one(self._scoped(statement))

    def _one(self, statement):
        try:
            return self._session.scalars(statement).one_or_none()
        except MultipleResultsFound as error:
            raise ProjectScopeError() from error

    def _scoped(self, statement):
        return scoped_statement(self._session, self._model_type, statement)

    def _require_project(self, project_id: str) -> None:
        require_project(self._session, project_id)

    def list(self, *, project_id: str | None = None) -> Sequence[EntityT]:
        statement = select(self._model_type)
        if self._project_scoped:
            if project_id is None:
                raise ValueError("project_id is required for project-scoped repositories")
            statement = statement.where(self._model_type.project_id == project_id)  # type: ignore[attr-defined]
            self._require_project(project_id)
        # Every supported SQL dialect exposes the same deterministic repository order.
        statement = statement.order_by(  # type: ignore[attr-defined]
            self._model_type.created_at,
            self._model_type.id,
        )
        return [self._entity_from_model(model) for model in self._session.scalars(self._scoped(statement)).all()]

    def update(self, entity: EntityT) -> EntityT:
        model = self._get_model(getattr(entity, "id"), project_id=getattr(entity, "project_id", None))
        if model is None:
            raise EntityNotFoundError(f"{self._model_type.__name__} not found: {getattr(entity, 'id')}")

        for key, value in self._model_values(entity).items():
            setattr(model, key, value)
        self._session.flush()
        return self._entity_from_model(model)

    def delete(self, entity_id: str) -> None:
        model = self._get_model(entity_id)
        if model is not None:
            validate_delete(self._session, self._model_type, model)
            self._session.delete(model)
            self._session.flush()

    def _model_from_entity(self, entity: EntityT) -> ModelT:
        return self._model_type(**self._model_values(entity))  # type: ignore[call-arg]

    def _model_values(self, entity: EntityT) -> dict[str, Any]:
        validate_entity(self._session, self._model_type, entity)
        return _entity_values(entity)

    def _entity_from_model(self, model: ModelT) -> EntityT:
        values: dict[str, Any] = {}
        for field in fields(self._entity_type):  # type: ignore[arg-type]
            key = "metadata_" if field.name == "metadata" else field.name
            values[field.name] = self._domain_value(getattr(model, key))
        return self._entity_type(**values)  # type: ignore[call-arg]

    def _domain_value(self, value: object) -> object:
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


class SqlAlchemyProjectRepository(SqlAlchemyRepository[ProjectEntity, models.Project]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.Project, ProjectEntity, project_scoped=False)

    def list(self) -> Sequence[ProjectEntity]:  # type: ignore[override]
        return super().list()


class SqlAlchemyNodeRepository(SqlAlchemyRepository[NodeEntity, models.Node]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.Node, NodeEntity)


class SqlAlchemyEdgeRepository(SqlAlchemyRepository[EdgeEntity, models.Edge]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.Edge, EdgeEntity)


class SqlAlchemyIssueRepository(SqlAlchemyRepository[IssueEntity, models.Issue]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.Issue, IssueEntity)


class SqlAlchemySuggestionRepository(SqlAlchemyRepository[SuggestionEntity, models.Suggestion]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.Suggestion, SuggestionEntity)


class SqlAlchemyImpactResolutionDecisionRepository(
    SqlAlchemyRepository[ImpactResolutionDecisionEntity, models.ImpactResolutionDecision]
):
    def __init__(self, session: Session) -> None:
        super().__init__(
            session,
            models.ImpactResolutionDecision,
            ImpactResolutionDecisionEntity,
        )


class SqlAlchemyEngineTagRepository(SqlAlchemyRepository[EngineTagEntity, models.EngineTag]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.EngineTag, EngineTagEntity)


class SqlAlchemyEngineTagDefinitionRepository(
    SqlAlchemyRepository[EngineTagDefinitionEntity, models.EngineTagDefinition]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.EngineTagDefinition, EngineTagDefinitionEntity)


class SqlAlchemyEngineTagBindingRepository(
    SqlAlchemyRepository[EngineTagBindingEntity, models.EngineTagBinding]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.EngineTagBinding, EngineTagBindingEntity)


class SqlAlchemyLegacyEngineTagRepository(
    SqlAlchemyRepository[LegacyEngineTagEntity, models.LegacyEngineTag]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.LegacyEngineTag, LegacyEngineTagEntity)

    def add(self, entity: LegacyEngineTagEntity) -> LegacyEngineTagEntity:
        raise ValueError("legacy engine tags are read-only")

    def update(self, entity: LegacyEngineTagEntity) -> LegacyEngineTagEntity:
        raise ValueError("legacy engine tags are read-only")

    def delete(self, entity_id: str) -> None:
        raise ValueError("legacy engine tags are read-only")


class SqlAlchemyVisualPlacementRepository(SqlAlchemyRepository[VisualPlacementEntity, models.VisualPlacement]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.VisualPlacement, VisualPlacementEntity)


class SqlAlchemyStoryFlowRepository(SqlAlchemyRepository[StoryFlowEntity, models.StoryFlow]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.StoryFlow, StoryFlowEntity)


class SqlAlchemyFlowScopedRepository(SqlAlchemyRepository[EntityT, ModelT]):
    """Adds flow filtering while retaining mandatory project scoping."""

    def list(self, *, project_id: str, flow_id: str | None = None) -> Sequence[EntityT]:
        self._require_project(project_id)
        statement = select(self._model_type).where(self._model_type.project_id == project_id)  # type: ignore[attr-defined]
        if flow_id is not None:
            statement = statement.where(self._model_type.flow_id == flow_id)  # type: ignore[attr-defined]
        return [self._entity_from_model(model) for model in self._session.scalars(self._scoped(statement)).all()]


class SqlAlchemyStoryFlowNodeRepository(
    SqlAlchemyFlowScopedRepository[StoryFlowNodeEntity, models.StoryFlowNode]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.StoryFlowNode, StoryFlowNodeEntity)

    def get_for_node(self, *, flow_id: str, node_id: str) -> StoryFlowNodeEntity | None:
        statement = select(models.StoryFlowNode).where(
            models.StoryFlowNode.flow_id == flow_id,
            models.StoryFlowNode.node_id == node_id,
        )
        model = self._one(self._scoped(statement))
        return self._entity_from_model(model) if model is not None else None


class SqlAlchemyFlowTransitionRepository(
    SqlAlchemyFlowScopedRepository[FlowTransitionEntity, models.FlowTransition]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.FlowTransition, FlowTransitionEntity)

    def reorder(
        self,
        *,
        flow_id: str,
        source_node_id: str,
        transition_ids: Sequence[str],
    ) -> Sequence[FlowTransitionEntity]:
        # Validate every sibling before either phase of a bulk reorder can write.
        for transition_id in transition_ids:
            candidate = self.get(transition_id)
            if candidate is None or candidate.flow_id != flow_id or candidate.source_node_id != source_node_id:
                raise ProjectScopeError()
        # Temporary priorities avoid the unique source/priority constraint while siblings swap.
        temporary_base = len(transition_ids) + 1_000_000
        for index, transition_id in enumerate(transition_ids):
            self._session.execute(
                self._scoped(update(models.FlowTransition)
                .where(models.FlowTransition.id == transition_id))
                .values(priority=temporary_base + index)
            )
        self._session.flush()
        now = datetime.now(UTC)
        for priority, transition_id in enumerate(transition_ids):
            self._session.execute(
                self._scoped(update(models.FlowTransition)
                .where(
                    models.FlowTransition.id == transition_id,
                    models.FlowTransition.flow_id == flow_id,
                    models.FlowTransition.source_node_id == source_node_id,
                ))
                .values(priority=priority, updated_at=now)
            )
        self._session.flush()
        return [
            transition
            for transition_id in transition_ids
            if (transition := self.get(transition_id)) is not None
        ]


class SqlAlchemySceneFlowBoundaryRepository(
    SqlAlchemyFlowScopedRepository[SceneFlowBoundaryEntity, models.SceneFlowBoundary]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.SceneFlowBoundary, SceneFlowBoundaryEntity)

    def get_for_scene(self, *, flow_id: str, scene_node_id: str) -> SceneFlowBoundaryEntity | None:
        statement = select(models.SceneFlowBoundary).where(
            models.SceneFlowBoundary.flow_id == flow_id,
            models.SceneFlowBoundary.scene_node_id == scene_node_id,
        )
        model = self._one(self._scoped(statement))
        return self._entity_from_model(model) if model is not None else None


class SqlAlchemyFlowInvocationRepository(
    SqlAlchemyRepository[FlowInvocationEntity, models.FlowInvocation]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.FlowInvocation, FlowInvocationEntity)

    def list(
        self,
        *,
        project_id: str,
        source_flow_id: str | None = None,
        target_flow_id: str | None = None,
    ) -> Sequence[FlowInvocationEntity]:
        self._require_project(project_id)
        statement = select(models.FlowInvocation).where(
            models.FlowInvocation.project_id == project_id
        )
        if source_flow_id is not None:
            statement = statement.where(models.FlowInvocation.source_flow_id == source_flow_id)
        if target_flow_id is not None:
            statement = statement.where(models.FlowInvocation.target_flow_id == target_flow_id)
        return [self._entity_from_model(model) for model in self._session.scalars(self._scoped(statement)).all()]


class SqlAlchemyFlowExitRepository(
    SqlAlchemyFlowScopedRepository[FlowExitEntity, models.FlowExit]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.FlowExit, FlowExitEntity)


class SqlAlchemyFlowExitBindingRepository(
    SqlAlchemyRepository[FlowExitBindingEntity, models.FlowExitBinding]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.FlowExitBinding, FlowExitBindingEntity)

    def list(
        self,
        *,
        project_id: str,
        invocation_id: str | None = None,
    ) -> Sequence[FlowExitBindingEntity]:
        self._require_project(project_id)
        statement = select(models.FlowExitBinding).where(
            models.FlowExitBinding.project_id == project_id
        )
        if invocation_id is not None:
            statement = statement.where(
                models.FlowExitBinding.invocation_id == invocation_id
            )
        return [self._entity_from_model(model) for model in self._session.scalars(self._scoped(statement)).all()]


class SqlAlchemyFlowInitialStateRepository(
    SqlAlchemyFlowScopedRepository[FlowInitialStateEntity, models.FlowInitialState]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.FlowInitialState, FlowInitialStateEntity)


class SqlAlchemyNarrativeEffectRepository(
    SqlAlchemyRepository[NarrativeEffectEntity, models.NarrativeEffect]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.NarrativeEffect, NarrativeEffectEntity)


class SqlAlchemyNarrativeEffectBindingRepository(
    SqlAlchemyRepository[NarrativeEffectBindingEntity, models.NarrativeEffectBinding]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.NarrativeEffectBinding, NarrativeEffectBindingEntity)

    def list(
        self,
        *,
        project_id: str,
        effect_id: str | None = None,
    ) -> Sequence[NarrativeEffectBindingEntity]:
        self._require_project(project_id)
        statement = select(models.NarrativeEffectBinding).where(
            models.NarrativeEffectBinding.project_id == project_id
        )
        if effect_id is not None:
            statement = statement.where(models.NarrativeEffectBinding.effect_id == effect_id)
        return [self._entity_from_model(model) for model in self._session.scalars(self._scoped(statement)).all()]


class SqlAlchemyStyleProfileRepository(
    SqlAlchemyRepository[StyleProfileEntity, models.StyleProfile]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.StyleProfile, StyleProfileEntity)


class SqlAlchemySceneStyleAssignmentRepository(
    SqlAlchemyRepository[SceneStyleAssignmentEntity, models.SceneStyleAssignment]
):
    def __init__(self, session: Session) -> None:
        super().__init__(session, models.SceneStyleAssignment, SceneStyleAssignmentEntity)


class SqlAlchemyAgentMemoryRepository(
    SqlAlchemyRepository[AgentMemoryEntity, models.AgentMemory]
):
    """Uses one validated implementation for SQLite and PostgreSQL storage."""

    def __init__(self, session: Session) -> None:
        super().__init__(session, models.AgentMemory, AgentMemoryEntity)

    def add(self, memory: AgentMemoryEntity) -> AgentMemoryEntity:
        validate_entity(self._session, self._model_type, memory)
        self._validate_candidate(memory)
        return super().add(memory)

    def add_many(self, memories: Sequence[AgentMemoryEntity]) -> Sequence[AgentMemoryEntity]:
        """Fresh call-local validation, including custom identity and owner rules."""
        if type(self) is not SqlAlchemyAgentMemoryRepository:
            return [self.add(memory) for memory in memories]
        if not memories:
            return []
        validate_entities(self._session, self._model_type, memories)
        projects = {memory.project_id for memory in memories}
        if len(projects) != 1:
            # Legacy unbound callers may mix projects; preserve their ordered adds.
            return [self.add(memory) for memory in memories]
        project_id = memories[0].project_id
        if self._session.get(models.Project, project_id) is None:
            raise ValueError(f"agent memory project not found: {project_id}")
        existing = list(self.list(project_id=project_id))
        node_owners, flow_owners = {}, {}
        for model, identities, owners in (
            (models.Node, {memory.scope.get("scene_node_id") or memory.scope.get("node_id")
                for memory in memories if memory.scope.get("kind") not in {"project", "story_flow"}}, node_owners),
            (models.StoryFlow, {memory.scope.get("flow_id")
                for memory in memories if memory.scope.get("kind") == "story_flow"}, flow_owners),
        ):
            ordered = sorted(identity for identity in identities if isinstance(identity, str))
            for start in range(0, len(ordered), 400):
                rows = self._session.scalars(select(model).where(
                    model.project_id == project_id, model.id.in_(ordered[start:start + 400])))
                owners.update((row.id, row) for row in rows)
        for memory in memories:
            self._validate_scope_owner(memory, node_owners=node_owners, flow_owners=flow_owners)
            self._validate_identity(memory, existing)
            # Ordered supersession and duplicate checks see earlier group entries.
            existing.append(memory)
        models_to_add = [self._model_type(**_entity_values(memory)) for memory in memories]
        self._session.add_all(models_to_add)
        self._session.flush()
        return [self._entity_from_model(model) for model in models_to_add]

    def update(self, memory: AgentMemoryEntity) -> AgentMemoryEntity:
        if self._get_model(memory.id, project_id=memory.project_id) is None:
            raise EntityNotFoundError(f"AgentMemory not found: {memory.id}")
        validate_entity(self._session, self._model_type, memory)
        self._validate_candidate(memory, replacing_id=memory.id)
        return super().update(memory)

    def list_for_owner(
        self, *, project_id: str, owner_kind: str, owner_id: str
    ) -> Sequence[AgentMemoryEntity]:
        if owner_kind not in {"scene", "node", "dialogue_field", "story_flow"}:
            raise ValueError(f"unsupported agent memory owner kind: {owner_kind}")
        return [
            memory
            for memory in self.list(project_id=project_id)
            if memory.scope.get("kind") == owner_kind
            and _agent_memory_owner_id(memory.scope) == owner_id
        ]

    def _validate_candidate(
        self,
        memory: AgentMemoryEntity,
        *,
        replacing_id: str | None = None,
    ) -> None:
        """Apply dialect-independent ownership and identity constraints before flush."""

        project = self._session.get(models.Project, memory.project_id)
        if project is None:
            raise ValueError(f"agent memory project not found: {memory.project_id}")
        self._validate_scope_owner(memory)
        existing = [
            item
            for item in self.list(project_id=memory.project_id)
            if item.id != replacing_id
        ]
        self._validate_identity(memory, existing)

    @staticmethod
    def _validate_identity(memory: AgentMemoryEntity, existing: Sequence[AgentMemoryEntity]) -> None:
        """Single and batch writes share the same identity/supersession validator."""
        if memory.supersedes_id is not None:
            superseded = next(
                (item for item in existing if item.id == memory.supersedes_id),
                None,
            )
            if (
                superseded is None
                or superseded.agent_id != memory.agent_id
                or superseded.content_locale != memory.content_locale
            ):
                raise ValueError(f"agent memory supersedes invalid record: {memory.id}")
        if memory.status == "active" and any(
            item.status == "active"
            and item.agent_id == memory.agent_id
            and item.content_locale == memory.content_locale
            and item.scope == memory.scope
            and item.title.strip().casefold() == memory.title.strip().casefold()
            for item in existing
        ):
            raise ValueError(f"agent memory active identity duplicated: {memory.id}")
        by_id = {item.id: item for item in [*existing, memory]}
        visited: set[str] = set()
        current: AgentMemoryEntity | None = memory
        while current is not None:
            if current.id in visited:
                raise ValueError(f"agent memory supersession cycle: {memory.id}")
            visited.add(current.id)
            current = (
                by_id.get(current.supersedes_id)
                if current.supersedes_id is not None
                else None
            )

    def _validate_scope_owner(self, memory: AgentMemoryEntity, *, node_owners=None, flow_owners=None) -> None:
        scope = memory.scope
        kind = scope.get("kind")
        if kind == "project":
            return
        if kind == "story_flow":
            flow = flow_owners.get(scope.get("flow_id")) if flow_owners is not None else self._session.scalar(
                select(models.StoryFlow).where(models.StoryFlow.id == scope.get("flow_id"),
                    models.StoryFlow.project_id == memory.project_id))
            if flow is None or flow.project_id != memory.project_id:
                raise ValueError(f"agent memory Story Flow owner not found: {memory.id}")
            return
        node_id = scope.get("scene_node_id") or scope.get("node_id")
        node = node_owners.get(node_id) if node_owners is not None else self._session.scalar(
            select(models.Node).where(models.Node.id == node_id, models.Node.project_id == memory.project_id))
        if node is None or node.project_id != memory.project_id:
            raise ValueError(f"agent memory node owner not found: {memory.id}")
        if kind == "scene" and node.type != "Scene":
            raise ValueError(f"agent memory Scene owner is invalid: {memory.id}")
        if kind == "dialogue_field" and node.type != "Dialogue":
            raise ValueError(f"agent memory Dialogue owner is invalid: {memory.id}")


# Reviewed implementations with no extra add/mapping behavior. Contract tests
# require re-review if a listed implementation later gains a custom validator.
_BATCH_ADD_REPOSITORIES = frozenset((
    SqlAlchemyNodeRepository, SqlAlchemyEdgeRepository, SqlAlchemyIssueRepository,
    SqlAlchemySuggestionRepository, SqlAlchemyImpactResolutionDecisionRepository,
    SqlAlchemyEngineTagRepository, SqlAlchemyEngineTagDefinitionRepository,
    SqlAlchemyEngineTagBindingRepository, SqlAlchemyVisualPlacementRepository,
    SqlAlchemyStoryFlowRepository, SqlAlchemyStoryFlowNodeRepository,
    SqlAlchemyFlowTransitionRepository, SqlAlchemySceneFlowBoundaryRepository,
    SqlAlchemyFlowInvocationRepository, SqlAlchemyFlowExitRepository,
    SqlAlchemyFlowExitBindingRepository, SqlAlchemyFlowInitialStateRepository,
    SqlAlchemyNarrativeEffectRepository, SqlAlchemyNarrativeEffectBindingRepository,
    SqlAlchemyStyleProfileRepository, SqlAlchemySceneStyleAssignmentRepository,
))


class SqlAlchemyUnitOfWork(UnitOfWork):
    def __init__(self, session_factory: Callable[[], Session], *, project_id: str | None = None,
                 before_commit: Callable[[UnitOfWork], None] | None = None,
                 borrowed_session: Session | None = None) -> None:
        self._session_factory = session_factory
        self._session: Session | None = None
        self._project_id = project_id
        self._before_commit = before_commit
        self._borrowed_session = borrowed_session

    def __enter__(self) -> "SqlAlchemyUnitOfWork":
        self._session = self._borrowed_session or self._session_factory()
        if self._project_id is not None:
            self._session.info["project_scope"] = self._project_id
        self.projects: ProjectRepository = SqlAlchemyProjectRepository(self._session)
        self.nodes: NodeRepository = SqlAlchemyNodeRepository(self._session)
        self.edges: EdgeRepository = SqlAlchemyEdgeRepository(self._session)
        self.issues: IssueRepository = SqlAlchemyIssueRepository(self._session)
        self.suggestions: SuggestionRepository = SqlAlchemySuggestionRepository(self._session)
        self.impact_resolution_decisions: ImpactResolutionDecisionRepository = (
            SqlAlchemyImpactResolutionDecisionRepository(self._session)
        )
        self.engine_tags: EngineTagRepository = SqlAlchemyEngineTagRepository(self._session)
        self.engine_tag_definitions: EngineTagDefinitionRepository = SqlAlchemyEngineTagDefinitionRepository(
            self._session
        )
        self.engine_tag_bindings: EngineTagBindingRepository = SqlAlchemyEngineTagBindingRepository(self._session)
        self.legacy_engine_tags: LegacyEngineTagRepository = SqlAlchemyLegacyEngineTagRepository(self._session)
        self.visual_placements: VisualPlacementRepository = SqlAlchemyVisualPlacementRepository(self._session)
        self.story_flows: StoryFlowRepository = SqlAlchemyStoryFlowRepository(self._session)
        self.story_flow_nodes: StoryFlowNodeRepository = SqlAlchemyStoryFlowNodeRepository(self._session)
        self.flow_transitions: FlowTransitionRepository = SqlAlchemyFlowTransitionRepository(self._session)
        self.scene_flow_boundaries: SceneFlowBoundaryRepository = SqlAlchemySceneFlowBoundaryRepository(self._session)
        self.flow_invocations: FlowInvocationRepository = SqlAlchemyFlowInvocationRepository(self._session)
        self.flow_exits: FlowExitRepository = SqlAlchemyFlowExitRepository(self._session)
        self.flow_exit_bindings: FlowExitBindingRepository = SqlAlchemyFlowExitBindingRepository(self._session)
        self.flow_initial_states: FlowInitialStateRepository = SqlAlchemyFlowInitialStateRepository(self._session)
        self.narrative_effects: NarrativeEffectRepository = SqlAlchemyNarrativeEffectRepository(self._session)
        self.narrative_effect_bindings: NarrativeEffectBindingRepository = SqlAlchemyNarrativeEffectBindingRepository(self._session)
        self.style_profiles: StyleProfileRepository = SqlAlchemyStyleProfileRepository(
            self._session
        )
        self.scene_style_assignments: SceneStyleAssignmentRepository = (
            SqlAlchemySceneStyleAssignmentRepository(self._session)
        )
        self.agent_memories: AgentMemoryRepository = SqlAlchemyAgentMemoryRepository(
            self._session
        )
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        if exc_type is not None:
            self.rollback()
        self.close()

    def commit(self) -> None:
        if self._before_commit is not None:
            self._before_commit(self)
        if self._borrowed_session is not None:
            # The composing transaction owner publishes the durable command once.
            self._require_session().flush()
        else:
            self._require_session().commit()

    def rollback(self) -> None:
        self._require_session().rollback()

    def close(self) -> None:
        if self._session is not None:
            if self._borrowed_session is None:
                self._session.close()
            self._session = None

    def _require_session(self) -> Session:
        if self._session is None:
            raise RuntimeError("Unit of work has not been entered")
        return self._session


def _agent_memory_owner_id(scope: dict[str, Any]) -> str | None:
    """Extract the canonical owner while preserving the portable nested scope."""

    if scope.get("kind") in {"scene", "node", "dialogue_field"}:
        return str(scope.get("scene_node_id") or scope.get("node_id") or "")
    if scope.get("kind") == "story_flow":
        return str(scope.get("flow_id") or "")
    return None
