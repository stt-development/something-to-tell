"""Create Phase 1 persistence tables.

Revision ID: 20260527_0001
Revises:
Create Date: 2026-05-27
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260527_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def common_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "projects",
        *common_columns(),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("format_version", sa.Integer(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "nodes",
        *common_columns(),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_nodes_project_id", "nodes", ["project_id"])

    op.create_table(
        "edges",
        *common_columns(),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("source_node_id", sa.String(length=255), nullable=False),
        sa.Column("target_node_id", sa.String(length=255), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("condition", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_edges_project_id", "edges", ["project_id"])
    op.create_index("ix_edges_source_node_id", "edges", ["source_node_id"])
    op.create_index("ix_edges_target_node_id", "edges", ["target_node_id"])

    op.create_table(
        "issues",
        *common_columns(),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("node_id", sa.String(length=255), nullable=True),
        sa.Column("edge_id", sa.String(length=255), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("severity", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["node_id"], ["nodes.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["edge_id"], ["edges.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_issues_project_id", "issues", ["project_id"])
    op.create_index("ix_issues_node_id", "issues", ["node_id"])
    op.create_index("ix_issues_edge_id", "issues", ["edge_id"])

    op.create_table(
        "suggestions",
        *common_columns(),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("patch", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=255), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_suggestions_project_id", "suggestions", ["project_id"])

    op.create_table(
        "engine_tags",
        *common_columns(),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=False),
        sa.Column("target_id", sa.String(length=255), nullable=False),
        sa.Column("engine", sa.String(length=64), nullable=False),
        sa.Column("key", sa.String(length=255), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_engine_tags_project_id", "engine_tags", ["project_id"])
    op.create_index("ix_engine_tags_target_id", "engine_tags", ["target_id"])


def downgrade() -> None:
    op.drop_index("ix_engine_tags_target_id", table_name="engine_tags")
    op.drop_index("ix_engine_tags_project_id", table_name="engine_tags")
    op.drop_table("engine_tags")
    op.drop_index("ix_suggestions_project_id", table_name="suggestions")
    op.drop_table("suggestions")
    op.drop_index("ix_issues_edge_id", table_name="issues")
    op.drop_index("ix_issues_node_id", table_name="issues")
    op.drop_index("ix_issues_project_id", table_name="issues")
    op.drop_table("issues")
    op.drop_index("ix_edges_target_node_id", table_name="edges")
    op.drop_index("ix_edges_source_node_id", table_name="edges")
    op.drop_index("ix_edges_project_id", table_name="edges")
    op.drop_table("edges")
    op.drop_index("ix_nodes_project_id", table_name="nodes")
    op.drop_table("nodes")
    op.drop_table("projects")
