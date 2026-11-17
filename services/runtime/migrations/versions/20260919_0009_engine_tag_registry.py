"""Persist versioned Engine Tag definitions, bindings, and v5 quarantine."""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260919_0009"
down_revision: str | None = "20260911_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "engine_tag_definitions",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("tag_version", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(length=160), nullable=False),
        sa.Column("normalized_key", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("aliases", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("tag_version = 1", name="ck_engine_tag_definitions_version"),
        sa.CheckConstraint("status IN ('active', 'archived')", name="ck_engine_tag_definitions_status"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "normalized_key", name="uq_engine_tag_definitions_project_key"),
    )
    op.create_index("ix_engine_tag_definitions_project_id", "engine_tag_definitions", ["project_id"])

    op.create_table(
        "engine_tag_bindings",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("definition_id", sa.String(length=255), nullable=False),
        sa.Column("tag_version", sa.Integer(), nullable=False),
        sa.Column("owner", sa.JSON(), nullable=False),
        sa.Column("owner_key", sa.String(length=512), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("tag_version = 1", name="ck_engine_tag_bindings_version"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["definition_id"], ["engine_tag_definitions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "definition_id", "owner_key", name="uq_engine_tag_bindings_owner"),
    )
    op.create_index("ix_engine_tag_bindings_project_id", "engine_tag_bindings", ["project_id"])
    op.create_index("ix_engine_tag_bindings_definition_id", "engine_tag_bindings", ["definition_id"])

    op.create_table(
        "legacy_engine_tags",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=False),
        sa.Column("target_id", sa.String(length=255), nullable=False),
        sa.Column("engine", sa.String(length=64), nullable=False),
        sa.Column("key", sa.String(length=255), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_legacy_engine_tags_project_id", "legacy_engine_tags", ["project_id"])

    # Preserve every generic row before the new service can reinterpret it.
    op.execute(
        sa.text(
            "INSERT INTO legacy_engine_tags "
            "(id, project_id, target_type, target_id, engine, key, value, metadata, created_at, updated_at) "
            "SELECT id, project_id, target_type, target_id, engine, key, value, metadata, created_at, updated_at "
            "FROM engine_tags"
        )
    )


def downgrade() -> None:
    op.drop_index("ix_legacy_engine_tags_project_id", table_name="legacy_engine_tags")
    op.drop_table("legacy_engine_tags")
    op.drop_index("ix_engine_tag_bindings_definition_id", table_name="engine_tag_bindings")
    op.drop_index("ix_engine_tag_bindings_project_id", table_name="engine_tag_bindings")
    op.drop_table("engine_tag_bindings")
    op.drop_index("ix_engine_tag_definitions_project_id", table_name="engine_tag_definitions")
    op.drop_table("engine_tag_definitions")
