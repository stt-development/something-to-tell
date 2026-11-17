"""P9-004 lease records. Shared upgrades require stopped legacy writers."""

from uuid import uuid4
from alembic import op
import sqlalchemy as sa

revision = "20261022_0011"
down_revision = "20261021_0010"
branch_labels = None
depends_on = None
metadata = sa.MetaData()
# Freeze schema here: historical migrations never import runtime metadata.
projects = sa.Table("projects", metadata, sa.Column("id", sa.String, primary_key=True))
control = sa.Table(
    "remote_storage_control", metadata,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("maintenance", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("transaction_seconds", sa.Integer, nullable=False, server_default="20"),
    sa.Column("lease_seconds", sa.Integer, nullable=False, server_default="60"),
    sa.Column("renew_seconds", sa.Integer, nullable=False, server_default="15"),
    sa.CheckConstraint("id = 1"),
    sa.CheckConstraint("transaction_seconds BETWEEN 1 AND 120"),
    sa.CheckConstraint("lease_seconds BETWEEN 3 AND 600"),
    sa.CheckConstraint("renew_seconds BETWEEN 1 AND 150"),
    sa.CheckConstraint("lease_seconds >= 3 * transaction_seconds"),
    sa.CheckConstraint("renew_seconds * 4 <= lease_seconds"),
)

head = sa.Table(
    "project_storage_heads", metadata,
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
    "remote_command_receipts", metadata,
    sa.Column("project_id", sa.String, primary_key=True),
    sa.Column("storage_generation", sa.String(36), primary_key=True),
    sa.Column("command_id", sa.String(36), primary_key=True),
    sa.Column("digest", sa.String, nullable=False),
    sa.Column("base_revision", sa.BigInteger, nullable=False),
    sa.Column("result_revision", sa.BigInteger, nullable=False),
    sa.Column("checksum", sa.String, nullable=False),
    sa.Column("outcome", sa.JSON, nullable=False),
    sa.ForeignKeyConstraint(["project_id", "storage_generation"],
                            ["project_storage_heads.project_id", "project_storage_heads.storage_generation"], ondelete="CASCADE"),
)
checkpoints = sa.Table(
    "remote_saved_checkpoints", metadata,
    sa.Column("project_id", sa.String, primary_key=True),
    sa.Column("storage_generation", sa.String(36), primary_key=True),
    sa.Column("saved_revision", sa.BigInteger, primary_key=True),
    sa.Column("saved_authoring_revision", sa.BigInteger, nullable=False),
    sa.Column("document", sa.JSON, nullable=False),
    sa.Column("checksum", sa.String, nullable=False),
    sa.ForeignKeyConstraint(["project_id", "storage_generation"],
                            ["project_storage_heads.project_id", "project_storage_heads.storage_generation"], ondelete="CASCADE"),
)


def upgrade():
    bind = op.get_bind()
    for table in (control, head, receipts, checkpoints):
        table.create(bind)
    bind.execute(control.insert().values(id=1))
    # Explicit admin upgrade provisions existing identities; ordinary Open never does.
    for project_id in bind.scalars(sa.select(projects.c.id)):
        bind.execute(head.insert().values(project_id=project_id, storage_generation=str(uuid4())))


def downgrade():
    raise RuntimeError("remote_ownership_downgrade_requires_verified_backup_restore")
