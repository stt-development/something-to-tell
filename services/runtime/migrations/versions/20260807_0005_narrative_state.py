"""Add Phase 3.11 narrative state and effect persistence.

Revision ID: 20260807_0005
Revises: 20260803_0004
Create Date: 2026-08-07
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260807_0005"
down_revision: str | None = "20260803_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def timestamp_columns() -> list[sa.Column]:
    """Keep generated state records aligned with the runtime TimestampMixin."""

    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    # Existing projects receive empty tables. No semantic relationship is read
    # or converted into executable custody by this schema migration.
    op.create_table(
        "flow_initial_states",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("flow_id", sa.String(length=255), nullable=False),
        sa.Column("state_version", sa.Integer(), nullable=False),
        sa.Column("flags", sa.JSON(), nullable=False),
        sa.Column("item_custody", sa.JSON(), nullable=False),
        sa.Column("quest_statuses", sa.JSON(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("state_version = 1", name="ck_flow_initial_states_version"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["flow_id"], ["story_flows.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "flow_id", name="uq_flow_initial_states_project_flow"
        ),
    )
    op.create_index("ix_flow_initial_states_project_id", "flow_initial_states", ["project_id"])
    op.create_index("ix_flow_initial_states_flow_id", "flow_initial_states", ["flow_id"])

    op.create_table(
        "narrative_effects",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("effect_version", sa.Integer(), nullable=False),
        sa.Column("operation", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("repeat_policy", sa.String(length=32), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("effect_version = 1", name="ck_narrative_effects_version"),
        sa.CheckConstraint(
            "operation IN ('transfer_item', 'set_flag', 'clear_flag', "
            "'set_quest_status', 'record_dialogue_choice')",
            name="ck_narrative_effects_operation",
        ),
        sa.CheckConstraint(
            "repeat_policy IN ('once', 'per_visit')",
            name="ck_narrative_effects_repeat_policy",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_narrative_effects_project_id", "narrative_effects", ["project_id"])

    op.create_table(
        "narrative_effect_bindings",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.String(length=255), nullable=False),
        sa.Column("effect_id", sa.String(length=255), nullable=False),
        sa.Column("binding_version", sa.Integer(), nullable=False),
        sa.Column("owner_kind", sa.String(length=64), nullable=False),
        sa.Column("owner_id", sa.String(length=255), nullable=False),
        sa.Column("context_node_id", sa.String(length=255), nullable=True),
        sa.Column("application_order", sa.Integer(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("binding_version = 1", name="ck_narrative_effect_bindings_version"),
        sa.CheckConstraint("application_order >= 0", name="ck_narrative_effect_bindings_order"),
        sa.CheckConstraint(
            "owner_kind IN ('node_entry', 'flow_transition', 'dialogue_element', "
            "'dialogue_option', 'quest_branch', 'quest_outcome', "
            "'flow_invocation', 'flow_exit')",
            name="ck_narrative_effect_bindings_owner_kind",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["effect_id"], ["narrative_effects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["context_node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("project_id", "effect_id", "owner_kind", "owner_id", "context_node_id"):
        op.create_index(
            f"ix_narrative_effect_bindings_{column}",
            "narrative_effect_bindings",
            [column],
        )


def downgrade() -> None:
    for column in ("context_node_id", "owner_id", "owner_kind", "effect_id", "project_id"):
        op.drop_index(
            f"ix_narrative_effect_bindings_{column}",
            table_name="narrative_effect_bindings",
        )
    op.drop_table("narrative_effect_bindings")
    op.drop_index("ix_narrative_effects_project_id", table_name="narrative_effects")
    op.drop_table("narrative_effects")
    op.drop_index("ix_flow_initial_states_flow_id", table_name="flow_initial_states")
    op.drop_index("ix_flow_initial_states_project_id", table_name="flow_initial_states")
    op.drop_table("flow_initial_states")
