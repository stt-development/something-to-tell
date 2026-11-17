from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class EntityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    created_at: datetime
    updated_at: datetime


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    path: str = Field(min_length=1)
    format_version: int = Field(ge=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectUpdate(ProjectCreate):
    pass


class ProjectResponse(ProjectCreate, EntityResponse):
    pass


class NodeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    type: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="canon", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class NodeUpdate(NodeCreate):
    pass


class NodeResponse(NodeCreate, EntityResponse):
    pass


class EdgeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    type: str = Field(min_length=1, max_length=64)
    label: str = Field(default="", max_length=255)
    condition: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class EdgeUpdate(EdgeCreate):
    pass


class EdgeResponse(EdgeCreate, EntityResponse):
    pass


class IssueCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=255)
    node_id: str | None = None
    edge_id: str | None = None
    description: str = ""
    severity: str = Field(default="info", min_length=1, max_length=64)
    status: str = Field(default="open", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class IssueUpdate(IssueCreate):
    pass


class IssueResponse(IssueCreate, EntityResponse):
    pass


class SuggestionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    status: str = Field(default="pending", min_length=1, max_length=64)
    patch: dict[str, Any] = Field(default_factory=dict)
    created_by: str = Field(default="local-user", min_length=1, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SuggestionUpdate(SuggestionCreate):
    pass


class SuggestionResponse(SuggestionCreate, EntityResponse):
    pass


class EngineTagCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    target_type: str = Field(min_length=1, max_length=64)
    target_id: str = Field(min_length=1, max_length=36)
    engine: str = Field(min_length=1, max_length=64)
    key: str = Field(min_length=1, max_length=255)
    value: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class EngineTagUpdate(EngineTagCreate):
    pass


class EngineTagResponse(EngineTagCreate, EntityResponse):
    pass
