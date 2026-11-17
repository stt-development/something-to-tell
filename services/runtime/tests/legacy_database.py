"""Build genuine historical schemas for migration tests, never forged head stamps."""

from alembic import command
from sqlalchemy import MetaData, create_engine, select

from services.runtime.stt_runtime.project_session.database import alembic_config


def rewrite_sqlite_checkpoint_at_revision(path, revision):
    temporary = path.with_suffix(".legacy.tmp")
    command.upgrade(alembic_config(f"sqlite:///{temporary}"), revision)
    source, target = create_engine(f"sqlite:///{path}"), create_engine(f"sqlite:///{temporary}")
    try:
        old, current = MetaData(), MetaData()
        old.reflect(bind=target)
        current.reflect(bind=source)
        with source.connect() as read, target.begin() as write:
            for table in old.sorted_tables:
                if table.name == "alembic_version":
                    continue
                rows = read.execute(select(current.tables[table.name])).mappings().all()
                if rows:
                    write.execute(table.insert(), [{key: row[key] for key in table.c.keys()} for row in rows])
    finally:
        source.dispose()
        target.dispose()
    temporary.replace(path)
