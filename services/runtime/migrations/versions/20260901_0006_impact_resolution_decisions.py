"""Add bounded Impact Resolution decision memory.

Revision ID: 20260901_0006
Revises: 20260807_0005
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260901_0006"
down_revision: str | None = "20260807_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Provider prose is intentionally absent: only stable review identity is durable.
    op.create_table(
        "impact_resolution_decisions",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("decision_version", sa.Integer(), nullable=False),
        sa.Column("finding_fingerprints", sa.JSON(), nullable=False),
        sa.Column("proposal_semantic_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("source_checksum", sa.String(length=64), nullable=False),
        sa.Column("decision", sa.String(length=16), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("decision_version = 1", name="ck_impact_resolution_decision_version"),
        sa.CheckConstraint(
            "decision IN ('approved', 'rejected')",
            name="ck_impact_resolution_decision_value",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "source_checksum",
            "proposal_semantic_fingerprint",
            name="uq_impact_resolution_decision_identity",
        ),
    )
    op.create_index(
        "ix_impact_resolution_decisions_project_id",
        "impact_resolution_decisions",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_impact_resolution_decisions_project_id",
        table_name="impact_resolution_decisions",
    )
    op.drop_table("impact_resolution_decisions")
