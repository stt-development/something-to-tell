from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, engine_from_config, pool

from services.runtime.stt_runtime.db.base import Base, import_model_metadata

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

import_model_metadata()
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    external = config.attributes.get("connection")
    if external is not None:
        # Future coordinated administration must retain its lock and DDL in one
        # caller-owned transaction; never finalize or replace this connection.
        # SQLAlchemy's transaction flag alone does not exclude DBAPI autocommit.
        if (not isinstance(external, Connection) or external.dialect.name != "postgresql"
                or not external.in_transaction()
                or getattr(external.connection.driver_connection, "autocommit", True) is not False):
            raise ValueError("migration_external_transaction_required")
        context.configure(connection=external, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        return

    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        if connection.dialect.name == "sqlite":
            # sqlite3 legacy transaction mode does not BEGIN for DDL. Make the
            # entire Alembic chain atomic, including batch table replacement.
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            connection.commit()
            connection.exec_driver_sql("BEGIN")
        context.configure(connection=connection, target_metadata=target_metadata)

        try:
            with context.begin_transaction():
                context.run_migrations()
            connection.commit()
        except Exception:
            connection.rollback()
            raise


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
