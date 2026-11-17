from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

NODE_KINDS = (
    "Character",
    "Quest",
    "Scene",
    "Lore",
    "Location",
    "Dialogue",
    "Faction",
    "Item",
    "Event",
    "Condition",
    "Consequence",
)
EDGE_TYPES = (
    "appears_in",
    "located_in",
    "belongs_to",
    "owns",
    "allied_with",
    "opposes",
    "requires",
    "unlocks",
    "causes",
    "reveals",
    "mentions",
    "contradicts",
    "depends_on",
    "changes",
    "leads_to",
)

NodeKind = Literal[
    "Character",
    "Quest",
    "Scene",
    "Lore",
    "Location",
    "Dialogue",
    "Faction",
    "Item",
    "Event",
    "Condition",
    "Consequence",
]
EdgeType = Literal[
    "appears_in",
    "located_in",
    "belongs_to",
    "owns",
    "allied_with",
    "opposes",
    "requires",
    "unlocks",
    "causes",
    "reveals",
    "mentions",
    "contradicts",
    "depends_on",
    "changes",
    "leads_to",
]


class SceneAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    scene_text: str = Field(min_length=1)
    title: str = Field(default="Untitled scene", min_length=1, max_length=255)
    provider: Literal["deterministic"] = "deterministic"
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvidenceSpan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_order(self) -> "EvidenceSpan":
        if self.start is not None and self.end is not None and self.end < self.start:
            raise ValueError("evidence end must be greater than or equal to start")
        return self


class ExtractedFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    kind: Literal["node", "edge"]
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    evidence: EvidenceSpan
    metadata: dict[str, Any] = Field(default_factory=dict)


class PatchNodeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: NodeKind
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="suggested", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class PatchNodeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    summary: str | None = None
    body: str | None = None
    status: str | None = Field(default=None, min_length=1, max_length=64)
    metadata: dict[str, Any] | None = None


class PatchEndpointRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str | None = Field(default=None, min_length=1)
    client_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_one_ref(self) -> "PatchEndpointRef":
        if bool(self.node_id) == bool(self.client_id):
            raise ValueError("endpoint must contain exactly one of node_id or client_id")
        return self


class PatchEdgeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: PatchEndpointRef
    target: PatchEndpointRef
    relationship_type: EdgeType = "depends_on"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_distinct_endpoints(self) -> "PatchEdgeCreate":
        if self.source == self.target:
            raise ValueError("edge endpoints must be distinct")
        return self


class PatchEdgeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relationship_type: EdgeType | None = None
    label: str | None = Field(default=None, max_length=255)
    condition: str | None = None
    metadata: dict[str, Any] | None = None


class CreateNodeOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["create_node"]
    client_id: str = Field(min_length=1)
    node: PatchNodeCreate


class UpdateNodeOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["update_node"]
    node_id: str = Field(min_length=1)
    updates: PatchNodeUpdate


class CreateEdgeOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["create_edge"]
    client_id: str = Field(min_length=1)
    edge: PatchEdgeCreate


class UpdateEdgeOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["update_edge"]
    edge_id: str = Field(min_length=1)
    updates: PatchEdgeUpdate


# The discriminator keeps graph patch validation strict and deterministic.
PatchOperation = Annotated[
    CreateNodeOperation | UpdateNodeOperation | CreateEdgeOperation | UpdateEdgeOperation,
    Field(discriminator="op"),
]


class GraphPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    operations: list[PatchOperation] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SceneAnalysisResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    suggestion_id: str | None = None
    provider: Literal["deterministic"] = "deterministic"
    extracted_facts: list[ExtractedFact] = Field(default_factory=list)
    patch: GraphPatch
    warnings: list[str] = Field(default_factory=list)
