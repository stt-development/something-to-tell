"""SQLite enforces the same project-relative reference constraints as PostgreSQL."""

from sqlalchemy import event


def enable_foreign_keys(engine):
    if engine.dialect.name != "sqlite":
        return

    @event.listens_for(engine, "connect")
    def configure(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
