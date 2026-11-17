import json
import os
from pathlib import Path
from threading import RLock
from typing import Literal
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.config import Config
from alembic.script import ScriptDirectory
from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import URL, create_engine, inspect, text
from sqlalchemy.engine import Engine

from .schemas.storage import StorageHost, StorageProfileSummary, StorageProfileTestResponse
from .storage_failures import storage_failure_code
from .schemas.remote_storage import (
    REMOTE_CONNECT_TIMEOUT_SECONDS, REMOTE_POOL_TIMEOUT_SECONDS,
    REMOTE_LOCK_TIMEOUT_SECONDS, REMOTE_STATEMENT_TIMEOUT_SECONDS,
    REMOTE_TRANSACTION_TIMEOUT_SECONDS, REMOTE_SUPPORTED_POSTGRES_MAJORS,
)
from .storage_permissions import profile_permissions_valid
from .migration_resources import migration_config


class StorageProfileError(ValueError):
    """Stable profile failure that never includes connection exception text."""

    def __init__(self, code: str, *, profile_id: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.profile_id = profile_id


class PostgreSqlProfile(BaseModel):
    """Immutable runtime-only connection snapshot; replacement needs a new profile."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    profile_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    host: StorageHost
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str = Field(min_length=1, repr=False)
    tls_policy: Literal["disable", "require", "verify-full"] = "verify-full"

    @field_validator("profile_id", "label", "host", "database", "username")
    @classmethod
    def normalize_visible_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized

    def summary(self) -> StorageProfileSummary:
        return StorageProfileSummary(
            profile_id=self.profile_id,
            label=self.label,
            host=self.host,
            port=self.port,
            database=self.database,
            username=self.username,
            tls_policy=self.tls_policy,
        )

    def database_url(self) -> URL:
        """Build a SQLAlchemy URL without rendering the secret to text."""

        return URL.create(
            "postgresql+psycopg",
            username=self.username,
            password=self.password,
            host=self.host,
            port=self.port,
            database=self.database,
            query={"sslmode": self.tls_policy},
        )


class _StorageProfileFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profiles: list[PostgreSqlProfile] = Field(default_factory=list)


class StorageProfileRegistry:
    """Resolves legacy and project-encrypted PostgreSQL profiles."""

    def __init__(
        self,
        profiles: list[PostgreSqlProfile] | None = None,
        *,
        master_key_file: Path | None = None,
    ) -> None:
        items = profiles or []
        if len({item.profile_id for item in items}) != len(items):
            raise StorageProfileError("storage_profile_duplicate")
        self._profiles = {item.profile_id: item for item in items}
        self._configuration_guard = RLock()
        self._master_key_file = (
            master_key_file or Path("~/.narrative/storage.key")
        ).expanduser()

    @classmethod
    def from_file(
        cls,
        path: Path,
        *,
        master_key_file: Path | None = None,
    ) -> "StorageProfileRegistry":
        resolved = path.expanduser()
        if not resolved.exists():
            return cls(master_key_file=master_key_file)
        try:
            payload = json.loads(resolved.read_text(encoding="utf-8"))
            parsed = _StorageProfileFile.model_validate(payload)
        except (OSError, json.JSONDecodeError, ValidationError) as error:
            raise StorageProfileError("storage_profile_file_invalid") from error
        return cls(parsed.profiles, master_key_file=master_key_file)

    def summaries(self, project_path: Path | None = None) -> list[StorageProfileSummary]:
        profiles = self._resolved_profiles(project_path)
        return sorted(
            (profile.summary() for profile in profiles.values()),
            key=lambda profile: (profile.label.casefold(), profile.profile_id),
        )

    def resolve(
        self,
        profile_id: str,
        project_path: Path | None = None,
    ) -> PostgreSqlProfile:
        profile = self._resolved_profiles(project_path).get(profile_id)
        if profile is None:
            raise StorageProfileError(
                "storage_profile_not_found",
                profile_id=profile_id,
            )
        return profile

    def create_engine(self, profile_id: str, project_path: Path | None = None) -> Engine:
        profile = self.resolve(profile_id, project_path)
        # Lease heartbeat and shutdown must not wait on unbounded connection/pool IO.
        return create_engine(profile.database_url(), pool_pre_ping=True, hide_parameters=True,
                             # Preserve SQLAlchemy's existing 5+10 connection capacity explicitly.
                             pool_size=5, max_overflow=10, pool_timeout=REMOTE_POOL_TIMEOUT_SECONDS,
                             connect_args={"connect_timeout": REMOTE_CONNECT_TIMEOUT_SECONDS,
                                           # Bound driver setup and pool pre-ping before local transaction policy.
                                           "options": f"-c statement_timeout={REMOTE_STATEMENT_TIMEOUT_SECONDS * 1000} "
                                                      f"-c lock_timeout={REMOTE_LOCK_TIMEOUT_SECONDS * 1000}"})

    def test(
        self,
        profile_id: str,
        project_path: Path | None = None,
    ) -> StorageProfileTestResponse:
        profile = self.resolve(profile_id, project_path)
        engine = self.create_engine(profile_id, project_path)
        try:
            with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
                connection.execute(text("SET TRANSACTION READ ONLY"))
                for name, seconds in (("lock_timeout", REMOTE_LOCK_TIMEOUT_SECONDS),
                                      ("statement_timeout", REMOTE_STATEMENT_TIMEOUT_SECONDS)):
                    connection.execute(text("SELECT set_config(:name, :value, true)"),
                                       {"name": name, "value": f"{seconds}s"})
                major = int(connection.scalar(text("SHOW server_version_num"))) // 10000
                if major not in REMOTE_SUPPORTED_POSTGRES_MAJORS:
                    raise StorageProfileError("remote_server_version_unsupported", profile_id=profile_id)
                # PG17 bounds the entire health transaction, not just each catalog query.
                connection.execute(text("SELECT set_config('transaction_timeout', :value, true)"),
                                   {"value": f"{REMOTE_TRANSACTION_TIMEOUT_SECONDS}s"})
                connected = connection.execute(text("select 1")).scalar_one() == 1
                tls_active = bool(
                    connection.execute(
                        text(
                            "select ssl from pg_stat_ssl "
                            "where pid = pg_backend_pid()"
                        )
                    ).scalar_one()
                )
                if profile.tls_policy != "disable" and not tls_active:
                    raise StorageProfileError(
                        "storage_profile_tls_mismatch",
                        profile_id=profile_id,
                    )
                if profile.tls_policy == "disable" and tls_active:
                    raise StorageProfileError(
                        "storage_profile_tls_mismatch",
                        profile_id=profile_id,
                    )
                revision = MigrationContext.configure(connection).get_current_revision()
                tables = {
                    name
                    for name in inspect(connection).get_table_names()
                    if name != "alembic_version"
                }
                head = ScriptDirectory.from_config(self._alembic_config()).get_current_head()
                if revision is None and not tables:
                    schema_status = "empty"
                elif revision == head:
                    schema_status = "current"
                else:
                    raise StorageProfileError(
                        "storage_profile_schema_mismatch",
                        profile_id=profile_id,
                    )
                permissions_valid = profile_permissions_valid(connection, empty_schema=schema_status == "empty")
            return StorageProfileTestResponse(
                profile=profile.summary(),
                connected=connected,
                tls_active=tls_active,
                schema_status=schema_status,
                schema_revision=revision,
                permissions_valid=permissions_valid,
            )
        except StorageProfileError:
            raise
        except Exception as error:
            code = storage_failure_code(error)
            raise StorageProfileError(
                "storage_profile_unavailable" if code == "remote_storage_unavailable" else code,
                profile_id=profile_id,
            ) from None
        finally:
            engine.dispose()

    def add(
        self,
        project_path: Path,
        *,
        label: str,
        host: str,
        port: int,
        database: str,
        username: str,
        password: str,
        tls_policy: Literal["disable", "require", "verify-full"],
    ) -> StorageProfileSummary:
        """Encrypt and persist one profile under the owning project."""

        profile = PostgreSqlProfile(
            profile_id=f"profile-{uuid4()}",
            label=label,
            host=host,
            port=port,
            database=database,
            username=username,
            password=password,
            tls_policy=tls_policy,
        )
        # Both session and pre-Open callers share this read/append/write owner.
        with self._configuration_guard:
            profiles = self._project_profiles(project_path)
            profiles.append(profile)
            self._write_project_profiles(project_path, profiles)
        return profile.summary()

    def _resolved_profiles(
        self,
        project_path: Path | None,
    ) -> dict[str, PostgreSqlProfile]:
        profiles = dict(self._profiles)
        if project_path is not None:
            profiles.update(
                (profile.profile_id, profile)
                for profile in self._project_profiles(project_path)
            )
        return profiles

    def _project_profiles(self, project_path: Path) -> list[PostgreSqlProfile]:
        encrypted_file = project_path / "storage-profiles.enc"
        if not encrypted_file.exists():
            return []
        try:
            payload = self._fernet(create=False).decrypt(encrypted_file.read_bytes())
            parsed = _StorageProfileFile.model_validate_json(payload)
        except (OSError, InvalidToken, ValidationError) as error:
            raise StorageProfileError("storage_profile_bundle_invalid") from error
        return parsed.profiles

    def _write_project_profiles(
        self,
        project_path: Path,
        profiles: list[PostgreSqlProfile],
    ) -> None:
        encrypted_file = project_path / "storage-profiles.enc"
        temporary = encrypted_file.with_suffix(".enc.tmp")
        payload = _StorageProfileFile(profiles=profiles).model_dump_json().encode()
        try:
            temporary.write_bytes(self._fernet(create=True).encrypt(payload))
            os.chmod(temporary, 0o600)
            temporary.replace(encrypted_file)
        except OSError as error:
            temporary.unlink(missing_ok=True)
            raise StorageProfileError("storage_profile_bundle_write_failed") from error

    def _fernet(self, *, create: bool) -> Fernet:
        if not self._master_key_file.exists():
            if not create:
                raise StorageProfileError("storage_profile_key_missing")
            self._master_key_file.parent.mkdir(parents=True, exist_ok=True)
            try:
                self._master_key_file.write_bytes(Fernet.generate_key())
                os.chmod(self._master_key_file, 0o600)
            except OSError as error:
                raise StorageProfileError("storage_profile_key_write_failed") from error
        try:
            return Fernet(self._master_key_file.read_bytes())
        except (OSError, ValueError) as error:
            raise StorageProfileError("storage_profile_key_invalid") from error

    @staticmethod
    def _alembic_config() -> Config:
        return migration_config()
