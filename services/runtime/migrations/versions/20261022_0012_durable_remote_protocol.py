"""P9-005 schema capability boundary: v11 clients must not write durable heads."""

from alembic import op
import sqlalchemy as sa

revision = "20261022_0012"
down_revision = "20261022_0011"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # Explicit admin upgrade still requires stopped/revoked legacy logins.
        # This control lock serializes with cooperative v11 leases, not legacy SQL.
        bind.execute(sa.text("SET LOCAL lock_timeout='3s'"))
        bind.execute(sa.text("SELECT id FROM remote_storage_control WHERE id=1 FOR UPDATE"))
        if bind.scalar(sa.text("SELECT count(*) FROM project_storage_heads WHERE owner_token IS NOT NULL AND lease_expires_at > clock_timestamp()")):
            raise RuntimeError("remote_upgrade_requires_stopped_writers")
        if bind.scalar(sa.text("SELECT count(*) FROM project_storage_heads WHERE owner_token IS NOT NULL AND writer_epoch=9223372036854775807")):
            raise RuntimeError("remote_revision_exhausted")
        # Fence dormant expired owners as well. Never reset their generation/ledger.
        bind.execute(sa.text("UPDATE project_storage_heads SET writer_epoch=writer_epoch+1, owner_token=NULL, lease_expires_at=NULL WHERE owner_token IS NOT NULL"))
    op.add_column("remote_storage_control", sa.Column("protocol_version", sa.Integer, nullable=False, server_default="1"))
    op.add_column("remote_storage_control", sa.Column("capabilities", sa.JSON, nullable=False,
        server_default=sa.text("'[\"consistent_capture\",\"durable_commands\",\"server_checkpoints\"]'")))
    with op.batch_alter_table("remote_storage_control") as batch:
        batch.create_check_constraint("ck_remote_protocol_version", "protocol_version=1")
    # Old-generation receipts must survive generation rotation. Their authority
    # is checked against the current locked head, not an FK to its mutable UUID.
    for table in ("remote_command_receipts", "remote_saved_checkpoints"):
        old = next(fk for fk in sa.inspect(bind).get_foreign_keys(table)
                   if fk["referred_table"] == "project_storage_heads")
        naming = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}
        with op.batch_alter_table(table, naming_convention=naming) as batch:
            batch.drop_constraint(old["name"] or f"fk_{table}_project_id_project_storage_heads", type_="foreignkey")
            batch.create_foreign_key(f"fk_{table}_project", "projects", ["project_id"], ["id"], ondelete="CASCADE")


def downgrade():
    raise RuntimeError("remote_protocol_downgrade_requires_verified_backup_restore")
