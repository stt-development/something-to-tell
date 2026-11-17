"""Add Phase 3.6 visual placement persistence.

Revision ID: 20260716_0002
Revises: 20260527_0001
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260716_0002"
down_revision: str | None = "20260527_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "visual_placements",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("container_node_id", sa.String(length=255), nullable=True),
        sa.Column("canonical_node_id", sa.String(length=255), nullable=False),
        sa.Column("scope_key", sa.String(length=64), nullable=False),
        sa.Column("x", sa.Float(), nullable=False),
        sa.Column("y", sa.Float(), nullable=False),
        sa.Column("width", sa.Float(), nullable=False),
        sa.Column("height", sa.Float(), nullable=False),
        sa.Column("is_primary", sa.Boolean(), nullable=False),
        sa.Column("presentation_state", sa.String(length=32), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["canonical_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["container_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "scope_key",
            "canonical_node_id",
            name="uq_visual_placements_project_scope_canonical",
        ),
    )
    op.create_index("ix_visual_placements_canonical_node_id", "visual_placements", ["canonical_node_id"])
    op.create_index("ix_visual_placements_container_node_id", "visual_placements", ["container_node_id"])
    op.create_index("ix_visual_placements_project_id", "visual_placements", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_visual_placements_project_id", table_name="visual_placements")
    op.drop_index("ix_visual_placements_container_node_id", table_name="visual_placements")
    op.drop_index("ix_visual_placements_canonical_node_id", table_name="visual_placements")
    op.drop_table("visual_placements")
