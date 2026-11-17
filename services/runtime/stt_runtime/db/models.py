from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, ForeignKeyConstraint, PrimaryKeyConstraint, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


def new_id() -> str:
    return str(uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    format_version: Mapped[int] = mapped_column(Integer, nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    nodes: Mapped[list["Node"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    edges: Mapped[list["Edge"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    issues: Mapped[list["Issue"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    suggestions: Mapped[list["Suggestion"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    impact_resolution_decisions: Mapped[list["ImpactResolutionDecision"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    engine_tags: Mapped[list["EngineTag"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    engine_tag_definitions: Mapped[list["EngineTagDefinition"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    engine_tag_bindings: Mapped[list["EngineTagBinding"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    legacy_engine_tags: Mapped[list["LegacyEngineTag"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    visual_placements: Mapped[list["VisualPlacement"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    story_flows: Mapped[list["StoryFlow"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    flow_invocations: Mapped[list["FlowInvocation"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    flow_exits: Mapped[list["FlowExit"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    flow_exit_bindings: Mapped[list["FlowExitBinding"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    flow_initial_states: Mapped[list["FlowInitialState"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    narrative_effects: Mapped[list["NarrativeEffect"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    narrative_effect_bindings: Mapped[list["NarrativeEffectBinding"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    style_profiles: Mapped[list["StyleProfile"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    scene_style_assignments: Mapped[list["SceneStyleAssignment"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    agent_memories: Mapped[list["AgentMemory"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Node(Base, TimestampMixin):
    __tablename__ = "nodes"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_nodes"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(64), default="canon", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="nodes")
    outgoing_edges: Mapped[list["Edge"]] = relationship(
        back_populates="source_node",
        foreign_keys="Edge.source_node_id",
        primaryjoin="and_(Node.project_id == Edge.project_id, Node.id == Edge.source_node_id)",
        passive_deletes=True,
    )
    incoming_edges: Mapped[list["Edge"]] = relationship(
        back_populates="target_node",
        foreign_keys="Edge.target_node_id",
        primaryjoin="and_(Node.project_id == Edge.project_id, Node.id == Edge.target_node_id)",
        passive_deletes=True,
    )


class Edge(Base, TimestampMixin):
    __tablename__ = "edges"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_edges"),
        ForeignKeyConstraint(["project_id", "source_node_id"], ["nodes.project_id", "nodes.id"], name="fk_source_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "target_node_id"], ["nodes.project_id", "nodes.id"], name="fk_target_node_id_nodes_project", ondelete="CASCADE"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    source_node_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    target_node_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    condition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="edges")
    source_node: Mapped[Node] = relationship(foreign_keys=[source_node_id], back_populates="outgoing_edges",
        primaryjoin="and_(Node.project_id == Edge.project_id, Node.id == Edge.source_node_id)")
    target_node: Mapped[Node] = relationship(foreign_keys=[target_node_id], back_populates="incoming_edges",
        primaryjoin="and_(Node.project_id == Edge.project_id, Node.id == Edge.target_node_id)")


class Issue(Base, TimestampMixin):
    __tablename__ = "issues"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_issues"),
        ForeignKeyConstraint(["project_id", "edge_id"], ["edges.project_id", "edges.id"], name="fk_edge_id_edges_project", ondelete="RESTRICT"),
        ForeignKeyConstraint(["project_id", "node_id"], ["nodes.project_id", "nodes.id"], name="fk_node_id_nodes_project", ondelete="RESTRICT"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    node_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    edge_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    severity: Mapped[str] = mapped_column(String(64), default="info", nullable=False)
    status: Mapped[str] = mapped_column(String(64), default="open", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="issues")
    node: Mapped[Node | None] = relationship(foreign_keys=[node_id],
        primaryjoin="and_(Node.project_id == Issue.project_id, Node.id == Issue.node_id)")
    edge: Mapped[Edge | None] = relationship(foreign_keys=[edge_id],
        primaryjoin="and_(Edge.project_id == Issue.project_id, Edge.id == Issue.edge_id)")


class Suggestion(Base, TimestampMixin):
    __tablename__ = "suggestions"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_suggestions"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(64), default="pending", nullable=False)
    patch: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_by: Mapped[str] = mapped_column(String(255), default="local-user", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="suggestions")


class ImpactResolutionDecision(Base, TimestampMixin):
    """Bounded durable decision identity with no provider-authored content."""

    __tablename__ = "impact_resolution_decisions"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_impact_resolution_decisions"),
        UniqueConstraint(
            "project_id",
            "source_checksum",
            "proposal_semantic_fingerprint",
            name="uq_impact_resolution_decision_identity",
        ),
        CheckConstraint("decision_version = 1", name="ck_impact_resolution_decision_version"),
        CheckConstraint(
            "decision IN ('approved', 'rejected')",
            name="ck_impact_resolution_decision_value",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    decision_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    finding_fingerprints: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    proposal_semantic_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    source_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    project: Mapped[Project] = relationship(back_populates="impact_resolution_decisions")


class EngineTag(Base, TimestampMixin):
    __tablename__ = "engine_tags"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_engine_tags"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    engine: Mapped[str] = mapped_column(String(64), nullable=False)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[str] = mapped_column(Text, default="", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="engine_tags")


class EngineTagDefinition(Base, TimestampMixin):
    """Stable registry identity; aliases remain target-neutral JSON."""

    __tablename__ = "engine_tag_definitions"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_engine_tag_definitions"),
        UniqueConstraint("project_id", "normalized_key", name="uq_engine_tag_definitions_project_key"),
        CheckConstraint("tag_version = 1", name="ck_engine_tag_definitions_version"),
        CheckConstraint("status IN ('active', 'archived')", name="ck_engine_tag_definitions_status"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    tag_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    key: Mapped[str] = mapped_column(String(160), nullable=False)
    normalized_key: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    aliases: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)

    project: Mapped[Project] = relationship(back_populates="engine_tag_definitions")


class EngineTagBinding(Base, TimestampMixin):
    """Stable definition binding to one typed authoring owner."""

    __tablename__ = "engine_tag_bindings"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_engine_tag_bindings"),
        ForeignKeyConstraint(["project_id", "definition_id"], ["engine_tag_definitions.project_id", "engine_tag_definitions.id"], name="fk_definition_id_engine_tag_definitions_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "definition_id", "owner_key", name="uq_engine_tag_bindings_owner"),
        CheckConstraint("tag_version = 1", name="ck_engine_tag_bindings_version"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    definition_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    tag_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    owner: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    owner_key: Mapped[str] = mapped_column(String(512), nullable=False)
    value: Mapped[str] = mapped_column(Text, default="", nullable=False)

    project: Mapped[Project] = relationship(back_populates="engine_tag_bindings")
    definition: Mapped[EngineTagDefinition] = relationship(foreign_keys=[definition_id],
        primaryjoin="and_(EngineTagDefinition.project_id == EngineTagBinding.project_id, EngineTagDefinition.id == EngineTagBinding.definition_id)")


class LegacyEngineTag(Base, TimestampMixin):
    """Read-only v5 quarantine; no update/delete repository is exposed."""

    __tablename__ = "legacy_engine_tags"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_legacy_engine_tags"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[str] = mapped_column(String(255), nullable=False)
    engine: Mapped[str] = mapped_column(String(64), nullable=False)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[str] = mapped_column(Text, default="", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="legacy_engine_tags")


class VisualPlacement(Base, TimestampMixin):
    """Stores reusable canvas geometry separately from canonical Node content."""

    __tablename__ = "visual_placements"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_visual_placements"),
        ForeignKeyConstraint(["project_id", "canonical_node_id"], ["nodes.project_id", "nodes.id"], name="fk_canonical_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "container_node_id"], ["nodes.project_id", "nodes.id"], name="fk_container_node_id_nodes_project", ondelete="CASCADE"),
        UniqueConstraint(
            "project_id",
            "scope_key",
            "canonical_node_id",
            name="uq_visual_placements_project_scope_canonical",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    container_node_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, index=True
    )
    canonical_node_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    # A non-null root sentinel makes root-scope uniqueness portable across SQL databases.
    scope_key: Mapped[str] = mapped_column(String(64), nullable=False)
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    width: Mapped[float] = mapped_column(Float, nullable=False)
    height: Mapped[float] = mapped_column(Float, nullable=False)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    presentation_state: Mapped[str] = mapped_column(String(32), default="expanded", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="visual_placements")


class StoryFlow(Base, TimestampMixin):
    """Stores one named narrative-order aggregate without owning canonical nodes."""

    __tablename__ = "story_flows"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_story_flows"),
        ForeignKeyConstraint(["project_id", "entry_node_id"], ["nodes.project_id", "nodes.id"], name="fk_entry_node_id_nodes_project", ondelete="RESTRICT"),
        UniqueConstraint("project_id", "normalized_name", name="uq_story_flows_project_normalized_name"),
        CheckConstraint("kind IN ('main', 'side', 'standalone')", name="ck_story_flows_kind"),
        CheckConstraint("status IN ('draft', 'active', 'archived')", name="ck_story_flows_status"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    kind: Mapped[str] = mapped_column(String(32), default="standalone", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    entry_node_id: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        index=True,
    )
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="story_flows")
    memberships: Mapped[list["StoryFlowNode"]] = relationship(
        back_populates="flow",
        cascade="all, delete-orphan",
        foreign_keys="StoryFlowNode.flow_id",
        primaryjoin="and_(StoryFlow.project_id == StoryFlowNode.project_id, StoryFlow.id == StoryFlowNode.flow_id)",
    )
    transitions: Mapped[list["FlowTransition"]] = relationship(
        back_populates="flow",
        cascade="all, delete-orphan",
        foreign_keys="FlowTransition.flow_id",
        primaryjoin="and_(StoryFlow.project_id == FlowTransition.project_id, StoryFlow.id == FlowTransition.flow_id)",
    )
    scene_boundaries: Mapped[list["SceneFlowBoundary"]] = relationship(
        back_populates="flow",
        cascade="all, delete-orphan",
        foreign_keys="SceneFlowBoundary.flow_id",
        primaryjoin="and_(StoryFlow.project_id == SceneFlowBoundary.project_id, StoryFlow.id == SceneFlowBoundary.flow_id)",
    )


class StoryFlowNode(Base, TimestampMixin):
    """Persists explicit flow membership independently from transition connectivity."""

    __tablename__ = "story_flow_nodes"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_story_flow_nodes"),
        ForeignKeyConstraint(["project_id", "flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_flow_id_story_flows_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "node_id"], ["nodes.project_id", "nodes.id"], name="fk_node_id_nodes_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "flow_id", "node_id", name="uq_story_flow_nodes_flow_node"),
        UniqueConstraint("project_id", "flow_id", "presentation_order", name="uq_story_flow_nodes_flow_order"),
        CheckConstraint("presentation_order >= 0", name="ck_story_flow_nodes_presentation_order"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    flow_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    node_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    presentation_order: Mapped[int] = mapped_column(Integer, nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    flow: Mapped[StoryFlow] = relationship(back_populates="memberships", foreign_keys=[flow_id],
        primaryjoin="and_(StoryFlow.project_id == StoryFlowNode.project_id, StoryFlow.id == StoryFlowNode.flow_id)")


class FlowTransition(Base, TimestampMixin):
    """Persists directed Story Flow order separately from semantic Edge records."""

    __tablename__ = "flow_transitions"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_flow_transitions"),
        ForeignKeyConstraint(["project_id", "flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_flow_id_story_flows_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "source_node_id"], ["nodes.project_id", "nodes.id"], name="fk_source_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "target_node_id"], ["nodes.project_id", "nodes.id"], name="fk_target_node_id_nodes_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "flow_id", "source_node_id", "priority", name="uq_flow_transitions_source_priority"),
        CheckConstraint("source_node_id <> target_node_id", name="ck_flow_transitions_distinct_endpoints"),
        CheckConstraint("priority >= 0", name="ck_flow_transitions_priority"),
        CheckConstraint("kind IN ('next', 'branch', 'optional', 'return')", name="ck_flow_transitions_kind"),
        CheckConstraint(
            "(NOT is_default) OR length(trim(condition)) = 0",
            name="ck_flow_transitions_default_condition",
        ),
        CheckConstraint(
            "kind <> 'branch' OR is_default OR length(trim(condition)) > 0",
            name="ck_flow_transitions_branch_condition",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    flow_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    source_node_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    target_node_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(32), default="next", nullable=False)
    label: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    condition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    flow: Mapped[StoryFlow] = relationship(back_populates="transitions", foreign_keys=[flow_id],
        primaryjoin="and_(StoryFlow.project_id == FlowTransition.project_id, StoryFlow.id == FlowTransition.flow_id)")


class SceneFlowBoundary(Base, TimestampMixin):
    """Persists a Scene's detailed flow entry and exits as one owned record."""

    __tablename__ = "scene_flow_boundaries"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_scene_flow_boundaries"),
        ForeignKeyConstraint(["project_id", "entry_node_id"], ["nodes.project_id", "nodes.id"], name="fk_entry_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_flow_id_story_flows_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "scene_node_id"], ["nodes.project_id", "nodes.id"], name="fk_scene_node_id_nodes_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "flow_id", "scene_node_id", name="uq_scene_flow_boundaries_flow_scene"),
        CheckConstraint("scene_node_id <> entry_node_id", name="ck_scene_flow_boundaries_distinct_entry"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True)
    flow_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    scene_node_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    entry_node_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    # Exit ids remain JSON because a boundary owns an ordered variable-length set;
    # service validation resolves each canonical node before persistence.
    exit_node_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    flow: Mapped[StoryFlow] = relationship(back_populates="scene_boundaries", foreign_keys=[flow_id],
        primaryjoin="and_(StoryFlow.project_id == SceneFlowBoundary.project_id, StoryFlow.id == SceneFlowBoundary.flow_id)")


class FlowInvocation(Base, TimestampMixin):
    """Persists an explicit call route without creating a cross-flow transition."""

    __tablename__ = "flow_invocations"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_flow_invocations"),
        ForeignKeyConstraint(["project_id", "source_flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_source_flow_id_story_flows_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "source_node_id"], ["nodes.project_id", "nodes.id"], name="fk_source_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "target_flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_target_flow_id_story_flows_project", ondelete="CASCADE"),
        UniqueConstraint("project_id",
            "source_flow_id",
            "source_node_id",
            "priority",
            name="uq_flow_invocations_source_priority",
        ),
        CheckConstraint("source_flow_id <> target_flow_id", name="ck_flow_invocations_distinct_flows"),
        CheckConstraint("priority >= 0", name="ck_flow_invocations_priority"),
        CheckConstraint(
            "(NOT is_default) OR length(trim(condition)) = 0",
            name="ck_flow_invocations_default_condition",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    source_flow_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    source_node_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    target_flow_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    condition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    project: Mapped[Project] = relationship(back_populates="flow_invocations")


class FlowExit(Base, TimestampMixin):
    """Persists a named terminal route exposed by one Story Flow."""

    __tablename__ = "flow_exits"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_flow_exits"),
        ForeignKeyConstraint(["project_id", "flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_flow_id_story_flows_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "source_node_id"], ["nodes.project_id", "nodes.id"], name="fk_source_node_id_nodes_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "flow_id", "key", name="uq_flow_exits_flow_key"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    flow_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    key: Mapped[str] = mapped_column(String(128), nullable=False)
    label: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    source_node_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )

    project: Mapped[Project] = relationship(back_populates="flow_exits")


class FlowExitBinding(Base, TimestampMixin):
    """Persists one call-site-specific return target in the immediate caller."""

    __tablename__ = "flow_exit_bindings"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_flow_exit_bindings"),
        ForeignKeyConstraint(["project_id", "exit_id"], ["flow_exits.project_id", "flow_exits.id"], name="fk_exit_id_flow_exits_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "invocation_id"], ["flow_invocations.project_id", "flow_invocations.id"], name="fk_invocation_id_flow_invocations_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "target_node_id"], ["nodes.project_id", "nodes.id"], name="fk_target_node_id_nodes_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "invocation_id", "exit_id", name="uq_flow_exit_bindings_call_exit"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    invocation_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    exit_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    target_node_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )

    project: Mapped[Project] = relationship(back_populates="flow_exit_bindings")


class FlowInitialState(Base, TimestampMixin):
    """Persists explicit root state without inferring custody from relationships."""

    __tablename__ = "flow_initial_states"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_flow_initial_states"),
        ForeignKeyConstraint(["project_id", "flow_id"], ["story_flows.project_id", "story_flows.id"], name="fk_flow_id_story_flows_project", ondelete="CASCADE"),
        UniqueConstraint("project_id", "flow_id", name="uq_flow_initial_states_project_flow"),
        CheckConstraint("state_version = 1", name="ck_flow_initial_states_version"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    flow_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    state_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    flags: Mapped[dict[str, bool]] = mapped_column(JSON, default=dict, nullable=False)
    item_custody: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    quest_statuses: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="flow_initial_states")


class NarrativeEffect(Base, TimestampMixin):
    """Persists a reusable versioned effect payload independently from its owners."""

    __tablename__ = "narrative_effects"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_narrative_effects"),
        CheckConstraint("effect_version = 1", name="ck_narrative_effects_version"),
        CheckConstraint(
            "operation IN ('transfer_item', 'set_flag', 'clear_flag', "
            "'set_quest_status', 'record_dialogue_choice')",
            name="ck_narrative_effects_operation",
        ),
        CheckConstraint(
            "repeat_policy IN ('once', 'per_visit')",
            name="ck_narrative_effects_repeat_policy",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    effect_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    repeat_policy: Mapped[str] = mapped_column(String(32), default="once", nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)

    project: Mapped[Project] = relationship(back_populates="narrative_effects")


class NarrativeEffectBinding(Base, TimestampMixin):
    """Persists deterministic effect order at a stable temporal owner."""

    __tablename__ = "narrative_effect_bindings"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_narrative_effect_bindings"),
        ForeignKeyConstraint(["project_id", "context_node_id"], ["nodes.project_id", "nodes.id"], name="fk_context_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "effect_id"], ["narrative_effects.project_id", "narrative_effects.id"], name="fk_effect_id_narrative_effects_project", ondelete="CASCADE"),
        CheckConstraint("binding_version = 1", name="ck_narrative_effect_bindings_version"),
        CheckConstraint("application_order >= 0", name="ck_narrative_effect_bindings_order"),
        CheckConstraint(
            "owner_kind IN ('node_entry', 'flow_transition', 'dialogue_element', "
            "'dialogue_option', 'quest_branch', 'quest_outcome', "
            "'flow_invocation', 'flow_exit')",
            name="ck_narrative_effect_bindings_owner_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    effect_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    binding_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    owner_kind: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    owner_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    context_node_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, index=True
    )
    application_order: Mapped[int] = mapped_column(Integer, nullable=False)

    project: Mapped[Project] = relationship(back_populates="narrative_effect_bindings")


class StyleProfile(Base, TimestampMixin):
    """Stores portable profile content without provider credentials or machine paths."""

    __tablename__ = "style_profiles"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_style_profiles"),
        CheckConstraint("style_profile_version = 1", name="ck_style_profiles_version"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    style_profile_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    guidance: Mapped[str] = mapped_column(Text, nullable=False)
    traits: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    positive_examples: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    project: Mapped[Project] = relationship(back_populates="style_profiles")
    scene_assignments: Mapped[list["SceneStyleAssignment"]] = relationship(
        back_populates="style_profile", cascade="all, delete-orphan",
        foreign_keys="SceneStyleAssignment.style_profile_id",
        primaryjoin="and_(StyleProfile.project_id == SceneStyleAssignment.project_id, StyleProfile.id == SceneStyleAssignment.style_profile_id)"
    )


class SceneStyleAssignment(Base, TimestampMixin):
    """Stores at most one explicit profile override per canonical Scene."""

    __tablename__ = "scene_style_assignments"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_scene_style_assignments"),
        ForeignKeyConstraint(["project_id", "scene_node_id"], ["nodes.project_id", "nodes.id"], name="fk_scene_node_id_nodes_project", ondelete="CASCADE"),
        ForeignKeyConstraint(["project_id", "style_profile_id"], ["style_profiles.project_id", "style_profiles.id"], name="fk_style_profile_id_style_profiles_project", ondelete="RESTRICT"),
        UniqueConstraint(
            "project_id", "scene_node_id", name="uq_scene_style_assignments_project_scene"
        ),
        CheckConstraint(
            "assignment_version = 1", name="ck_scene_style_assignments_version"
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    scene_node_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    style_profile_id: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    assignment_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    project: Mapped[Project] = relationship(back_populates="scene_style_assignments")
    style_profile: Mapped[StyleProfile] = relationship(back_populates="scene_assignments", foreign_keys=[style_profile_id],
        primaryjoin="and_(StyleProfile.project_id == SceneStyleAssignment.project_id, StyleProfile.id == SceneStyleAssignment.style_profile_id)")


class AgentMemory(Base, TimestampMixin):
    """Stores bounded reviewed guidance without provider request or session data."""

    __tablename__ = "agent_memories"
    __table_args__ = (
        PrimaryKeyConstraint("project_id", "id", name="pk_agent_memories"),
        CheckConstraint("memory_version = 1", name="ck_agent_memories_version"),
        CheckConstraint(
            "agent_id IN ('canon_checker', 'impact_resolver', 'style_rewriter')",
            name="ck_agent_memories_agent",
        ),
        CheckConstraint("namespace = agent_id", name="ck_agent_memories_namespace"),
        CheckConstraint("content_locale IN ('en', 'ru')", name="ck_agent_memories_locale"),
        CheckConstraint("status IN ('active', 'archived')", name="ck_agent_memories_status"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True, nullable=False, index=True
    )
    memory_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    agent_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    namespace: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    content_locale: Mapped[str] = mapped_column(String(8), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    supersedes_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    project: Mapped[Project] = relationship(back_populates="agent_memories")
