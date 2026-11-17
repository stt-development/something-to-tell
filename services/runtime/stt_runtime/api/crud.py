from collections.abc import Sequence
from typing import Any

from fastapi import HTTPException, status

from ..domain.entities import EdgeEntity, EngineTagEntity, IssueEntity, NodeEntity, ProjectEntity, SuggestionEntity
from ..engine_tags.automatic import add_node_with_automatic_tag, add_relationship_with_automatic_tag
from ..engine_tags.ownership import owner_removed_with_node, owner_removed_with_relationships
from ..repositories.interfaces import UnitOfWork
from ..repositories.sqlite import EntityNotFoundError
from ..schemas.resource_presenters import (
    edge_response,
    engine_tag_response,
    issue_response,
    node_response,
    project_response,
    suggestion_response,
)
from ..schemas.resources import (
    EdgeCreate,
    EdgeResponse,
    EdgeUpdate,
    EngineTagCreate,
    EngineTagResponse,
    EngineTagUpdate,
    IssueCreate,
    IssueResponse,
    IssueUpdate,
    NodeCreate,
    NodeResponse,
    NodeUpdate,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    SuggestionCreate,
    SuggestionResponse,
    SuggestionUpdate,
)

RESERVED_SEMANTIC_EDGE_TYPES = {"contains", "member_of"}
RESERVED_FLOW_EDGE_TYPES = {"flow_transition", "story_flow_transition"}


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def require_project(uow: UnitOfWork, project_id: str) -> ProjectEntity:
    project = uow.projects.get(project_id)
    if project is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", f"Project not found: {project_id}")
    return project


def create_project(uow: UnitOfWork, payload: ProjectCreate) -> ProjectResponse:
    project = uow.projects.add(ProjectEntity(**payload.model_dump()))
    uow.commit()
    return project_response(project)


def list_projects(uow: UnitOfWork) -> list[ProjectResponse]:
    return [project_response(project) for project in uow.projects.list()]


def get_project(uow: UnitOfWork, project_id: str) -> ProjectResponse:
    return project_response(require_project(uow, project_id))


def update_project(uow: UnitOfWork, project_id: str, payload: ProjectUpdate) -> ProjectResponse:
    existing = require_project(uow, project_id)
    try:
        project = uow.projects.update(ProjectEntity(id=project_id, created_at=existing.created_at, updated_at=existing.updated_at, **payload.model_dump()))
    except EntityNotFoundError as error:
        raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", str(error)) from error
    uow.commit()
    return project_response(project)


def delete_project(uow: UnitOfWork, project_id: str) -> None:
    require_project(uow, project_id)
    uow.projects.delete(project_id)
    uow.commit()


def create_node(uow: UnitOfWork, payload: NodeCreate) -> NodeResponse:
    require_project(uow, payload.project_id)
    try:
        node = add_node_with_automatic_tag(uow, NodeEntity(**payload.model_dump()))
        uow.commit()
    except Exception:
        # A canonical node and its initial tag are one authoring operation.
        uow.rollback()
        raise
    return node_response(node)


def list_nodes(uow: UnitOfWork, project_id: str) -> list[NodeResponse]:
    require_project(uow, project_id)
    return [node_response(node) for node in uow.nodes.list(project_id=project_id)]


def get_node(uow: UnitOfWork, node_id: str) -> NodeResponse:
    node = uow.nodes.get(node_id)
    if node is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "node_not_found", f"Node not found: {node_id}")
    return node_response(node)


def update_node(uow: UnitOfWork, node_id: str, payload: NodeUpdate) -> NodeResponse:
    existing = _require_node(uow, node_id)
    require_project(uow, payload.project_id)
    node = uow.nodes.update(NodeEntity(id=node_id, created_at=existing.created_at, updated_at=existing.updated_at, **payload.model_dump()))
    uow.commit()
    return node_response(node)


def delete_node(uow: UnitOfWork, node_id: str) -> None:
    node = _require_node(uow, node_id)
    if any(
        placement.canonical_node_id == node_id or placement.container_node_id == node_id
        for placement in uow.visual_placements.list(project_id=node.project_id)
    ):
        raise api_error(
            status.HTTP_409_CONFLICT,
            "composition_delete_requires_impact",
            "Remove or preview affected visual placements before deleting this node.",
        )
    invocations = uow.flow_invocations.list(project_id=node.project_id)
    exits = uow.flow_exits.list(project_id=node.project_id)
    bindings = uow.flow_exit_bindings.list(project_id=node.project_id)
    if (
        any(item.source_node_id == node_id for item in invocations)
        or any(item.source_node_id == node_id for item in exits)
        or any(item.target_node_id == node_id for item in bindings)
    ):
        raise api_error(
            status.HTTP_409_CONFLICT,
            "composable_flow_delete_requires_impact",
            "Preview and remove affected calls, exits, and bindings before deleting this node.",
        )
    memory_ids = {
        memory.id
        for kind in ("scene", "node", "dialogue_field")
        for memory in uow.agent_memories.list_for_owner(
            project_id=node.project_id,
            owner_kind=kind,
            owner_id=node_id,
        )
    }
    if memory_ids:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "agent_memory_owner_delete_requires_impact",
            "Preview affected agent memory before deleting this node: "
            + ", ".join(sorted(memory_ids)),
        )
    for binding in uow.engine_tag_bindings.list(project_id=node.project_id):
        if owner_removed_with_node(binding.owner, node_id):
            uow.engine_tag_bindings.delete(binding.id)
    uow.nodes.delete(node_id)
    uow.commit()


def create_edge(uow: UnitOfWork, payload: EdgeCreate) -> EdgeResponse:
    _validate_user_edge_type(payload.type, payload.metadata)
    _validate_edge_refs(uow, payload.project_id, payload.source_node_id, payload.target_node_id)
    try:
        edge = add_relationship_with_automatic_tag(uow, EdgeEntity(**payload.model_dump()))
        uow.commit()
    except Exception:
        # An authored relationship and its initial tag are one authoring operation.
        uow.rollback()
        raise
    return edge_response(edge)


def list_edges(uow: UnitOfWork, project_id: str) -> list[EdgeResponse]:
    require_project(uow, project_id)
    return [edge_response(edge) for edge in uow.edges.list(project_id=project_id)]


def get_edge(uow: UnitOfWork, edge_id: str) -> EdgeResponse:
    return edge_response(_require_edge(uow, edge_id))


def update_edge(uow: UnitOfWork, edge_id: str, payload: EdgeUpdate) -> EdgeResponse:
    existing = _require_edge(uow, edge_id)
    _validate_user_edge_type(existing.type, existing.metadata)
    _validate_user_edge_type(payload.type, payload.metadata)
    _validate_edge_refs(uow, payload.project_id, payload.source_node_id, payload.target_node_id)
    edge = uow.edges.update(EdgeEntity(id=edge_id, created_at=existing.created_at, updated_at=existing.updated_at, **payload.model_dump()))
    uow.commit()
    return edge_response(edge)


def delete_edge(uow: UnitOfWork, edge_id: str) -> None:
    edge = _require_edge(uow, edge_id)
    _validate_user_edge_type(edge.type, edge.metadata)
    for binding in uow.engine_tag_bindings.list(project_id=edge.project_id):
        if owner_removed_with_relationships(binding.owner, {edge_id}):
            uow.engine_tag_bindings.delete(binding.id)
    uow.edges.delete(edge_id)
    uow.commit()


def create_issue(uow: UnitOfWork, payload: IssueCreate) -> IssueResponse:
    _validate_optional_refs(uow, payload.project_id, payload.node_id, payload.edge_id)
    issue = uow.issues.add(IssueEntity(**payload.model_dump()))
    uow.commit()
    return issue_response(issue)


def list_issues(uow: UnitOfWork, project_id: str) -> list[IssueResponse]:
    require_project(uow, project_id)
    return [issue_response(issue) for issue in uow.issues.list(project_id=project_id)]


def get_issue(uow: UnitOfWork, issue_id: str) -> IssueResponse:
    return issue_response(_require_issue(uow, issue_id))


def update_issue(uow: UnitOfWork, issue_id: str, payload: IssueUpdate) -> IssueResponse:
    existing = _require_issue(uow, issue_id)
    _validate_optional_refs(uow, payload.project_id, payload.node_id, payload.edge_id)
    issue = uow.issues.update(IssueEntity(id=issue_id, created_at=existing.created_at, updated_at=existing.updated_at, **payload.model_dump()))
    uow.commit()
    return issue_response(issue)


def delete_issue(uow: UnitOfWork, issue_id: str) -> None:
    _require_issue(uow, issue_id)
    uow.issues.delete(issue_id)
    uow.commit()


def create_suggestion(uow: UnitOfWork, payload: SuggestionCreate) -> SuggestionResponse:
    require_project(uow, payload.project_id)
    suggestion = uow.suggestions.add(SuggestionEntity(**payload.model_dump()))
    uow.commit()
    return suggestion_response(suggestion)


def list_suggestions(uow: UnitOfWork, project_id: str) -> list[SuggestionResponse]:
    require_project(uow, project_id)
    return [suggestion_response(suggestion) for suggestion in uow.suggestions.list(project_id=project_id)]


def get_suggestion(uow: UnitOfWork, suggestion_id: str) -> SuggestionResponse:
    return suggestion_response(_require_suggestion(uow, suggestion_id))


def update_suggestion(uow: UnitOfWork, suggestion_id: str, payload: SuggestionUpdate) -> SuggestionResponse:
    existing = _require_suggestion(uow, suggestion_id)
    require_project(uow, payload.project_id)
    suggestion = uow.suggestions.update(SuggestionEntity(id=suggestion_id, created_at=existing.created_at, updated_at=existing.updated_at, **payload.model_dump()))
    uow.commit()
    return suggestion_response(suggestion)


def delete_suggestion(uow: UnitOfWork, suggestion_id: str) -> None:
    _require_suggestion(uow, suggestion_id)
    uow.suggestions.delete(suggestion_id)
    uow.commit()


def create_engine_tag(uow: UnitOfWork, payload: EngineTagCreate) -> EngineTagResponse:
    require_project(uow, payload.project_id)
    engine_tag = uow.engine_tags.add(EngineTagEntity(**payload.model_dump()))
    uow.commit()
    return engine_tag_response(engine_tag)


def list_engine_tags(uow: UnitOfWork, project_id: str) -> list[EngineTagResponse]:
    require_project(uow, project_id)
    return [engine_tag_response(engine_tag) for engine_tag in uow.engine_tags.list(project_id=project_id)]


def get_engine_tag(uow: UnitOfWork, engine_tag_id: str) -> EngineTagResponse:
    return engine_tag_response(_require_engine_tag(uow, engine_tag_id))


def update_engine_tag(uow: UnitOfWork, engine_tag_id: str, payload: EngineTagUpdate) -> EngineTagResponse:
    existing = _require_engine_tag(uow, engine_tag_id)
    require_project(uow, payload.project_id)
    engine_tag = uow.engine_tags.update(EngineTagEntity(id=engine_tag_id, created_at=existing.created_at, updated_at=existing.updated_at, **payload.model_dump()))
    uow.commit()
    return engine_tag_response(engine_tag)


def delete_engine_tag(uow: UnitOfWork, engine_tag_id: str) -> None:
    _require_engine_tag(uow, engine_tag_id)
    uow.engine_tags.delete(engine_tag_id)
    uow.commit()


def _require_node(uow: UnitOfWork, node_id: str) -> NodeEntity:
    node = uow.nodes.get(node_id)
    if node is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "node_not_found", f"Node not found: {node_id}")
    return node


def _require_edge(uow: UnitOfWork, edge_id: str) -> EdgeEntity:
    edge = uow.edges.get(edge_id)
    if edge is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "edge_not_found", f"Edge not found: {edge_id}")
    return edge


def _require_issue(uow: UnitOfWork, issue_id: str) -> IssueEntity:
    issue = uow.issues.get(issue_id)
    if issue is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "issue_not_found", f"Issue not found: {issue_id}")
    return issue


def _require_suggestion(uow: UnitOfWork, suggestion_id: str) -> SuggestionEntity:
    suggestion = uow.suggestions.get(suggestion_id)
    if suggestion is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "suggestion_not_found", f"Suggestion not found: {suggestion_id}")
    return suggestion


def _require_engine_tag(uow: UnitOfWork, engine_tag_id: str) -> EngineTagEntity:
    engine_tag = uow.engine_tags.get(engine_tag_id)
    if engine_tag is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "engine_tag_not_found", f"Engine tag not found: {engine_tag_id}")
    return engine_tag


def _validate_edge_refs(uow: UnitOfWork, project_id: str, source_node_id: str, target_node_id: str) -> None:
    require_project(uow, project_id)
    source = _require_node(uow, source_node_id)
    target = _require_node(uow, target_node_id)
    if source.project_id != project_id or target.project_id != project_id:
        raise api_error(status.HTTP_400_BAD_REQUEST, "cross_project_edge", "Edge nodes must belong to the edge project.")


def _validate_optional_refs(uow: UnitOfWork, project_id: str, node_id: str | None, edge_id: str | None) -> None:
    require_project(uow, project_id)
    if node_id is not None and _require_node(uow, node_id).project_id != project_id:
        raise api_error(status.HTTP_400_BAD_REQUEST, "cross_project_issue", "Issue node must belong to the issue project.")
    if edge_id is not None and _require_edge(uow, edge_id).project_id != project_id:
        raise api_error(status.HTTP_400_BAD_REQUEST, "cross_project_issue", "Issue edge must belong to the issue project.")


def _validate_user_edge_type(edge_type: str, metadata: dict[str, Any] | None = None) -> None:
    if edge_type in RESERVED_SEMANTIC_EDGE_TYPES:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "reserved_semantic_edge_type",
            f"Relationship type is owned by a dedicated semantic service: {edge_type}",
        )
    if edge_type in RESERVED_FLOW_EDGE_TYPES or (metadata or {}).get("semantic_scope") == "story_flow":
        raise api_error(
            status.HTTP_409_CONFLICT,
            "reserved_story_flow_edge",
            "Story Flow transitions must be written through the dedicated Story Flow API.",
        )
