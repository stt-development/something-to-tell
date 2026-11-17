"""Add portable reviewed agent memory records.

Revision ID: 20260911_0008
Revises: 20260904_0007
Create Date: 2026-09-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260911_0008"
down_revision: str | None = "20260904_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nested scope remains portable JSON; ProjectDocument validates its typed owner.
    op.create_table(
        "agent_memories",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("memory_version", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(length=64), nullable=False),
        sa.Column("namespace", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.JSON(), nullable=False),
        sa.Column("content_locale", sa.String(length=8), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("supersedes_id", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("memory_version = 1", name="ck_agent_memories_version"),
        sa.CheckConstraint(
            "agent_id IN ('canon_checker', 'impact_resolver', 'style_rewriter')",
            name="ck_agent_memories_agent",
        ),
        sa.CheckConstraint("namespace = agent_id", name="ck_agent_memories_namespace"),
        sa.CheckConstraint("content_locale IN ('en', 'ru')", name="ck_agent_memories_locale"),
        sa.CheckConstraint("status IN ('active', 'archived')", name="ck_agent_memories_status"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_memories_project_id", "agent_memories", ["project_id"])
    op.create_index("ix_agent_memories_agent_id", "agent_memories", ["agent_id"])
    op.create_index("ix_agent_memories_status", "agent_memories", ["status"])
    op.create_index("ix_agent_memories_supersedes_id", "agent_memories", ["supersedes_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_memories_supersedes_id", table_name="agent_memories")
    op.drop_index("ix_agent_memories_status", table_name="agent_memories")
    op.drop_index("ix_agent_memories_agent_id", table_name="agent_memories")
    op.drop_index("ix_agent_memories_project_id", table_name="agent_memories")
    op.drop_table("agent_memories")
