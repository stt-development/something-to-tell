"""Add Phase 3.7 Story Flow persistence.

Revision ID: 20260723_0003
Revises: 20260716_0002
Create Date: 2026-07-23
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260723_0003"
down_revision: str | None = "20260716_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def timestamp_columns() -> list[sa.Column]:
    """Keep migration timestamps aligned with the runtime TimestampMixin."""

    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    # Flow-owned tables reference canonical nodes but never cascade from a flow
    # into nodes, edges, or other canonical narrative records.
    op.create_table(
        "story_flows",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("normalized_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("entry_node_id", sa.String(length=255), nullable=True),
        sa.Column("metadata", sa.JSON(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("kind IN ('main', 'side', 'standalone')", name="ck_story_flows_kind"),
        sa.CheckConstraint("status IN ('draft', 'active', 'archived')", name="ck_story_flows_status"),
        sa.ForeignKeyConstraint(["entry_node_id"], ["nodes.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "normalized_name", name="uq_story_flows_project_normalized_name"),
    )
    op.create_index("ix_story_flows_entry_node_id", "story_flows", ["entry_node_id"])
    op.create_index("ix_story_flows_project_id", "story_flows", ["project_id"])

    op.create_table(
        "story_flow_nodes",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("flow_id", sa.String(length=255), nullable=False),
        sa.Column("node_id", sa.String(length=255), nullable=False),
        sa.Column("presentation_order", sa.Integer(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("presentation_order >= 0", name="ck_story_flow_nodes_presentation_order"),
        sa.ForeignKeyConstraint(["flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("flow_id", "node_id", name="uq_story_flow_nodes_flow_node"),
        sa.UniqueConstraint("flow_id", "presentation_order", name="uq_story_flow_nodes_flow_order"),
    )
    op.create_index("ix_story_flow_nodes_flow_id", "story_flow_nodes", ["flow_id"])
    op.create_index("ix_story_flow_nodes_node_id", "story_flow_nodes", ["node_id"])
    op.create_index("ix_story_flow_nodes_project_id", "story_flow_nodes", ["project_id"])

    op.create_table(
        "flow_transitions",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("flow_id", sa.String(length=255), nullable=False),
        sa.Column("source_node_id", sa.String(length=255), nullable=False),
        sa.Column("target_node_id", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("condition", sa.Text(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("source_node_id <> target_node_id", name="ck_flow_transitions_distinct_endpoints"),
        sa.CheckConstraint("priority >= 0", name="ck_flow_transitions_priority"),
        sa.CheckConstraint(
            "kind IN ('next', 'branch', 'optional', 'return')",
            name="ck_flow_transitions_kind",
        ),
        sa.CheckConstraint(
            "(NOT is_default) OR length(trim(condition)) = 0",
            name="ck_flow_transitions_default_condition",
        ),
        sa.CheckConstraint(
            "kind <> 'branch' OR is_default OR length(trim(condition)) > 0",
            name="ck_flow_transitions_branch_condition",
        ),
        sa.ForeignKeyConstraint(["flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "flow_id",
            "source_node_id",
            "priority",
            name="uq_flow_transitions_source_priority",
        ),
    )
    op.create_index("ix_flow_transitions_flow_id", "flow_transitions", ["flow_id"])
    op.create_index("ix_flow_transitions_project_id", "flow_transitions", ["project_id"])
    op.create_index("ix_flow_transitions_source_node_id", "flow_transitions", ["source_node_id"])
    op.create_index("ix_flow_transitions_target_node_id", "flow_transitions", ["target_node_id"])

    op.create_table(
        "scene_flow_boundaries",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("flow_id", sa.String(length=255), nullable=False),
        sa.Column("scene_node_id", sa.String(length=255), nullable=False),
        sa.Column("entry_node_id", sa.String(length=255), nullable=False),
        sa.Column("exit_node_ids", sa.JSON(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("scene_node_id <> entry_node_id", name="ck_scene_flow_boundaries_distinct_entry"),
        sa.ForeignKeyConstraint(["entry_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scene_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("flow_id", "scene_node_id", name="uq_scene_flow_boundaries_flow_scene"),
    )
    op.create_index("ix_scene_flow_boundaries_entry_node_id", "scene_flow_boundaries", ["entry_node_id"])
    op.create_index("ix_scene_flow_boundaries_flow_id", "scene_flow_boundaries", ["flow_id"])
    op.create_index("ix_scene_flow_boundaries_project_id", "scene_flow_boundaries", ["project_id"])
    op.create_index("ix_scene_flow_boundaries_scene_node_id", "scene_flow_boundaries", ["scene_node_id"])


def downgrade() -> None:
    op.drop_index("ix_scene_flow_boundaries_scene_node_id", table_name="scene_flow_boundaries")
    op.drop_index("ix_scene_flow_boundaries_project_id", table_name="scene_flow_boundaries")
    op.drop_index("ix_scene_flow_boundaries_flow_id", table_name="scene_flow_boundaries")
    op.drop_index("ix_scene_flow_boundaries_entry_node_id", table_name="scene_flow_boundaries")
    op.drop_table("scene_flow_boundaries")
    op.drop_index("ix_flow_transitions_target_node_id", table_name="flow_transitions")
    op.drop_index("ix_flow_transitions_source_node_id", table_name="flow_transitions")
    op.drop_index("ix_flow_transitions_project_id", table_name="flow_transitions")
    op.drop_index("ix_flow_transitions_flow_id", table_name="flow_transitions")
    op.drop_table("flow_transitions")
    op.drop_index("ix_story_flow_nodes_project_id", table_name="story_flow_nodes")
    op.drop_index("ix_story_flow_nodes_node_id", table_name="story_flow_nodes")
    op.drop_index("ix_story_flow_nodes_flow_id", table_name="story_flow_nodes")
    op.drop_table("story_flow_nodes")
    op.drop_index("ix_story_flows_project_id", table_name="story_flows")
    op.drop_index("ix_story_flows_entry_node_id", table_name="story_flows")
    op.drop_table("story_flows")
