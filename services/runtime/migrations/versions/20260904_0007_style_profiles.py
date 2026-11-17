"""Add portable style profiles and explicit Scene assignments.

Revision ID: 20260904_0007
Revises: 20260901_0006
Create Date: 2026-09-04
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260904_0007"
down_revision: str | None = "20260901_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Profiles contain authored guidance only; provider and credential data is excluded.
    op.create_table(
        "style_profiles",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("style_profile_version", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("guidance", sa.Text(), nullable=False),
        sa.Column("traits", sa.JSON(), nullable=False),
        sa.Column("positive_examples", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("style_profile_version = 1", name="ck_style_profiles_version"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_style_profiles_project_id", "style_profiles", ["project_id"])

    op.create_table(
        "scene_style_assignments",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("scene_node_id", sa.String(length=255), nullable=False),
        sa.Column("style_profile_id", sa.String(length=255), nullable=False),
        sa.Column("assignment_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "assignment_version = 1", name="ck_scene_style_assignments_version"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scene_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["style_profile_id"], ["style_profiles.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "scene_node_id",
            name="uq_scene_style_assignments_project_scene",
        ),
    )
    op.create_index(
        "ix_scene_style_assignments_project_id",
        "scene_style_assignments",
        ["project_id"],
    )
    op.create_index(
        "ix_scene_style_assignments_scene_node_id",
        "scene_style_assignments",
        ["scene_node_id"],
    )
    op.create_index(
        "ix_scene_style_assignments_style_profile_id",
        "scene_style_assignments",
        ["style_profile_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_scene_style_assignments_style_profile_id",
        table_name="scene_style_assignments",
    )
    op.drop_index(
        "ix_scene_style_assignments_scene_node_id",
        table_name="scene_style_assignments",
    )
    op.drop_index(
        "ix_scene_style_assignments_project_id",
        table_name="scene_style_assignments",
    )
    op.drop_table("scene_style_assignments")
    op.drop_index("ix_style_profiles_project_id", table_name="style_profiles")
    op.drop_table("style_profiles")
