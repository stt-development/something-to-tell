"""Add Phase 3.10 composable Story Flow persistence.

Revision ID: 20260803_0004
Revises: 20260723_0003
Create Date: 2026-08-03
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260803_0004"
down_revision: str | None = "20260723_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def timestamp_columns() -> list[sa.Column]:
    """Keep generated records aligned with the runtime TimestampMixin."""

    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    # Calls remain separate from transitions so flow ownership and semantic
    # relationship tables cannot be weakened by cross-flow endpoints.
    op.create_table(
        "flow_invocations",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("source_flow_id", sa.String(length=255), nullable=False),
        sa.Column("source_node_id", sa.String(length=255), nullable=False),
        sa.Column("target_flow_id", sa.String(length=255), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("condition", sa.Text(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("source_flow_id <> target_flow_id", name="ck_flow_invocations_distinct_flows"),
        sa.CheckConstraint("priority >= 0", name="ck_flow_invocations_priority"),
        sa.CheckConstraint(
            "(NOT is_default) OR length(trim(condition)) = 0",
            name="ck_flow_invocations_default_condition",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_flow_id",
            "source_node_id",
            "priority",
            name="uq_flow_invocations_source_priority",
        ),
    )
    for column in ("project_id", "source_flow_id", "source_node_id", "target_flow_id"):
        op.create_index(f"ix_flow_invocations_{column}", "flow_invocations", [column])

    op.create_table(
        "flow_exits",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("flow_id", sa.String(length=255), nullable=False),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("source_node_id", sa.String(length=255), nullable=False),
        *timestamp_columns(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("flow_id", "key", name="uq_flow_exits_flow_key"),
    )
    for column in ("project_id", "flow_id", "source_node_id"):
        op.create_index(f"ix_flow_exits_{column}", "flow_exits", [column])

    op.create_table(
        "flow_exit_bindings",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("invocation_id", sa.String(length=255), nullable=False),
        sa.Column("exit_id", sa.String(length=255), nullable=False),
        sa.Column("target_node_id", sa.String(length=255), nullable=False),
        *timestamp_columns(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invocation_id"], ["flow_invocations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["exit_id"], ["flow_exits.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("invocation_id", "exit_id", name="uq_flow_exit_bindings_call_exit"),
    )
    for column in ("project_id", "invocation_id", "exit_id", "target_node_id"):
        op.create_index(f"ix_flow_exit_bindings_{column}", "flow_exit_bindings", [column])


def downgrade() -> None:
    for column in ("target_node_id", "exit_id", "invocation_id", "project_id"):
        op.drop_index(f"ix_flow_exit_bindings_{column}", table_name="flow_exit_bindings")
    op.drop_table("flow_exit_bindings")
    for column in ("source_node_id", "flow_id", "project_id"):
        op.drop_index(f"ix_flow_exits_{column}", table_name="flow_exits")
    op.drop_table("flow_exits")
    for column in ("target_flow_id", "source_node_id", "source_flow_id", "project_id"):
        op.drop_index(f"ix_flow_invocations_{column}", table_name="flow_invocations")
    op.drop_table("flow_invocations")
