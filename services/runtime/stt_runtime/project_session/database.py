from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import DatabaseError
from sqlalchemy.orm import Session, sessionmaker

from ..db.base import Base, import_model_metadata
from ..db.sqlite_policy import enable_foreign_keys
from ..db.sqlite_backup import backup_sqlite
from ..domain.entities import ProjectEntity
from ..migration_resources import migration_config
from ..project_format.manifest import ProjectManifestV2
from ..repositories.sqlite import SqlAlchemyUnitOfWork
from .errors import ProjectSessionError


def alembic_config(database_url: str) -> Config:
    """Keep the session adapter API while sharing installed migration resources."""
    return migration_config(database_url)


def backup_database_for_upgrade(project_path: Path, database_path: Path) -> Path:
    """Copy a database before applying a migration that may need rollback."""

    backup_path = (
        project_path
        / "snapshots"
        / f"database-upgrade-backup-{uuid4().hex[:8]}.sqlite"
    )
    backup_sqlite(database_path, backup_path)
    return backup_path


def upgrade_database(
    database_path: Path,
    *,
    project_path: Path,
    backup_existing: bool,
) -> Path | None:
    """Upgrade a local database while preserving the pre-upgrade image on failure."""

    database_url = URL.create("sqlite", database=str(database_path)).render_as_string(
        hide_password=False
    )
    config = alembic_config(database_url)
    backup_path: Path | None = None
    try:
        probe_engine = create_engine(database_url)
        with probe_engine.connect() as connection:
            current_revision = MigrationContext.configure(connection).get_current_revision()
            user_tables = {
                table
                for table in inspect(connection).get_table_names()
                if table != "alembic_version"
            }
        probe_engine.dispose()
        head_revision = ScriptDirectory.from_config(config).get_current_head()
        if current_revision == head_revision:
            return None
        if current_revision is None and user_tables:
            raise ProjectSessionError(
                "project_database_unversioned",
                tables=sorted(user_tables),
            )
        backup_path = (
            backup_database_for_upgrade(project_path, database_path)
            if backup_existing
            else None
        )
        command.upgrade(config, "head")
        return backup_path
    except ProjectSessionError:
        raise
    except DatabaseError as error:
        if backup_path is not None:
            backup_sqlite(backup_path, database_path)
        raise ProjectSessionError("project_database_invalid") from error
    except Exception as error:
        if backup_path is not None:
            backup_sqlite(backup_path, database_path)
        raise ProjectSessionError("project_database_migration_failed") from error


def upgrade_external_database(database_url: URL) -> None:
    """Run the shared schema chain against an explicitly tested profile."""

    config = alembic_config(database_url.render_as_string(hide_password=False))
    try:
        command.upgrade(config, "head")
    except Exception as error:
        raise ProjectSessionError("storage_profile_schema_migration_failed") from error


def open_database(database_path: Path) -> Engine:
    """Open and validate a local SQLite project authority."""

    database_url = URL.create("sqlite", database=str(database_path))
    engine = create_engine(database_url, connect_args={"check_same_thread": False})
    enable_foreign_keys(engine)
    try:
        import_model_metadata()
        with engine.connect() as connection:
            health = connection.execute(text("pragma quick_check")).scalar_one()
            if health != "ok":
                raise ProjectSessionError(
                    "project_database_health_failed",
                    result=str(health),
                )
            tables = set(inspect(connection).get_table_names())
        missing_tables = sorted(set(Base.metadata.tables).difference(tables))
        if missing_tables:
            raise ProjectSessionError(
                "project_database_schema_incomplete",
                missing=missing_tables,
            )
    except Exception:
        engine.dispose()
        raise
    return engine


def validate_postgresql_engine(engine: Engine) -> None:
    """Require the shared schema and a live PostgreSQL transaction."""

    try:
        import_model_metadata()
        with engine.connect() as connection:
            version = int(connection.exec_driver_sql("SHOW server_version_num").scalar_one())
            if not 170000 <= version < 180000:
                raise ProjectSessionError("remote_server_version_unsupported")
            if connection.execute(text("select 1")).scalar_one() != 1:
                raise ProjectSessionError("storage_profile_health_failed")
            tables = set(inspect(connection).get_table_names())
        missing_tables = sorted(set(Base.metadata.tables).difference(tables))
        if missing_tables:
            raise ProjectSessionError(
                "project_database_schema_incomplete",
                missing=missing_tables,
            )
    except ProjectSessionError:
        raise
    except Exception as error:
        raise ProjectSessionError("storage_profile_unavailable") from error


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create the repository transaction factory for one authorized engine."""

    return sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
    )


def ensure_project_root(
    session_factory: sessionmaker[Session],
    project_path: Path,
    manifest: ProjectManifestV2,
    *,
    allow_multiple: bool = False,
) -> None:
    """Ensure storage contains exactly the project root authorized by its manifest."""

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        projects = list(uow.projects.list())
        if not projects:
            uow.projects.add(_project_entity(project_path, manifest))
            uow.commit()
            return
        matching = [project for project in projects if project.id == manifest.project_id]
        if allow_multiple and not matching:
            uow.projects.add(_project_entity(project_path, manifest))
            uow.commit()
            return
        if (not allow_multiple and len(projects) != 1) or len(matching) != 1:
            raise ProjectSessionError(
                "project_identity_mismatch",
                manifest_project_id=manifest.project_id,
            )
        project = matching[0]
        if (
            project.name != manifest.name
            or project.path != str(project_path)
            or project.format_version != manifest.format_version
        ):
            uow.projects.update(
                ProjectEntity(
                    id=project.id,
                    name=manifest.name,
                    path=str(project_path),
                    format_version=manifest.format_version,
                    metadata=project.metadata,
                    created_at=project.created_at,
                    updated_at=manifest.updated_at,
                )
            )
            uow.commit()


def _project_entity(project_path: Path, manifest: ProjectManifestV2) -> ProjectEntity:
    """Create the canonical root row for an empty storage authority."""

    return ProjectEntity(
        id=manifest.project_id,
        name=manifest.name,
        path=str(project_path),
        format_version=manifest.format_version,
        created_at=manifest.created_at,
        updated_at=manifest.updated_at,
    )
