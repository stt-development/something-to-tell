"""Persistence-neutral projection from domain entities to resource schemas."""

from typing import Any

from ..domain.entities import (
    EdgeEntity,
    EngineTagEntity,
    IssueEntity,
    NodeEntity,
    ProjectEntity,
    SuggestionEntity,
)
from .resources import (
    EdgeResponse,
    EngineTagResponse,
    IssueResponse,
    NodeResponse,
    ProjectResponse,
    SuggestionResponse,
)


def project_response(entity: ProjectEntity) -> ProjectResponse:
    """Project one domain entity onto its transport-neutral response contract."""

    return ProjectResponse(**_entity_dump(entity))


def node_response(entity: NodeEntity) -> NodeResponse:
    """Project one node entity onto its response contract."""

    return NodeResponse(**_entity_dump(entity))


def edge_response(entity: EdgeEntity) -> EdgeResponse:
    """Project one edge entity onto its response contract."""

    return EdgeResponse(**_entity_dump(entity))


def issue_response(entity: IssueEntity) -> IssueResponse:
    """Project one issue entity onto its response contract."""

    return IssueResponse(**_entity_dump(entity))


def suggestion_response(entity: SuggestionEntity) -> SuggestionResponse:
    """Project one suggestion entity onto its response contract."""

    return SuggestionResponse(**_entity_dump(entity))


def engine_tag_response(entity: EngineTagEntity) -> EngineTagResponse:
    """Project one engine-tag entity onto its response contract."""

    return EngineTagResponse(**_entity_dump(entity))


def _entity_dump(entity: object) -> dict[str, Any]:
    """Copy dataclass fields without exposing an ORM or API dependency."""

    return {key: getattr(entity, key) for key in entity.__dataclass_fields__}
