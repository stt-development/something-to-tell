"""Operational storage records, deliberately outside the portable document model."""

import sqlalchemy as sa

from .base import Base


control = sa.Table(
    "remote_storage_control", Base.metadata,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("maintenance", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("protocol_version", sa.Integer, nullable=False, server_default="1"),
    sa.Column("capabilities", sa.JSON, nullable=False,
              server_default=sa.text("'[\"consistent_capture\",\"durable_commands\",\"server_checkpoints\"]'")),
    sa.Column("transaction_seconds", sa.Integer, nullable=False, server_default="20"),
    sa.Column("lease_seconds", sa.Integer, nullable=False, server_default="60"),
    sa.Column("renew_seconds", sa.Integer, nullable=False, server_default="15"),
    sa.CheckConstraint("id = 1"),
    sa.CheckConstraint("protocol_version = 1"),
    sa.CheckConstraint("transaction_seconds BETWEEN 1 AND 120"),
    sa.CheckConstraint("lease_seconds BETWEEN 3 AND 600"),
    sa.CheckConstraint("renew_seconds BETWEEN 1 AND 150"),
    sa.CheckConstraint("lease_seconds >= 3 * transaction_seconds"),
    sa.CheckConstraint("renew_seconds * 4 <= lease_seconds"),
)

head = sa.Table(
    "project_storage_heads", Base.metadata,
    sa.Column("project_id", sa.String, sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("storage_generation", sa.String(36), nullable=False),
    sa.Column("writer_epoch", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("owner_token", sa.String(64)),
    sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
    sa.Column("authoring_revision", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("saved_authoring_revision", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("saved_revision", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("canonical_manifest", sa.JSON),
    sa.Column("checksum", sa.String),
    sa.CheckConstraint("writer_epoch >= 0 AND authoring_revision >= 0 AND saved_authoring_revision >= 0 AND saved_revision >= 0"),
    sa.CheckConstraint("(owner_token IS NULL AND lease_expires_at IS NULL) OR (owner_token IS NOT NULL AND lease_expires_at IS NOT NULL)"),
    sa.UniqueConstraint("project_id", "storage_generation"),
)

# Reserved for P9-005; creating these tables does not enable v2 publication.
receipts = sa.Table(
    "remote_command_receipts", Base.metadata,
    sa.Column("project_id", sa.String, primary_key=True),
    sa.Column("storage_generation", sa.String(36), primary_key=True),
    sa.Column("command_id", sa.String(36), primary_key=True),
    sa.Column("digest", sa.String, nullable=False),
    sa.Column("base_revision", sa.BigInteger, nullable=False),
    sa.Column("result_revision", sa.BigInteger, nullable=False),
    sa.Column("checksum", sa.String, nullable=False),
    sa.Column("outcome", sa.JSON, nullable=False),
    sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
)
checkpoints = sa.Table(
    "remote_saved_checkpoints", Base.metadata,
    sa.Column("project_id", sa.String, primary_key=True),
    sa.Column("storage_generation", sa.String(36), primary_key=True),
    sa.Column("saved_revision", sa.BigInteger, primary_key=True),
    sa.Column("saved_authoring_revision", sa.BigInteger, nullable=False),
    sa.Column("document", sa.JSON, nullable=False),
    sa.Column("checksum", sa.String, nullable=False),
    sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
)


def owner_predicate(lease):
    """SQL identity shared by ownership and publication adapters, not domain data."""
    return (head.c.project_id == lease.project_id) & (head.c.storage_generation == lease.generation) & (
        head.c.writer_epoch == lease.epoch) & (head.c.owner_token == lease.token)
