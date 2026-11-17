from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..project_format.manifest import ProjectSettings
from .project_document import ProjectDocument
from .remote_storage import RemoteStorageHeadV1, RemoteSessionState

PROJECT_SESSION_VERSION = 1


class ProjectSessionCreate(BaseModel):
    """Creates and opens one new local project workspace."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    settings: ProjectSettings = Field(default_factory=ProjectSettings)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        """Reject names that contain no author-visible characters."""

        normalized = value.strip()
        if not normalized:
            raise ValueError("name must not be blank")
        return normalized


class ProjectSessionSettingsUpdate(BaseModel):
    """Replaces the mutable, versioned project manifest settings."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    settings: ProjectSettings
    expected_history_revision: int | None = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        """Apply the same project-name boundary used during creation."""

        normalized = value.strip()
        if not normalized:
            raise ValueError("name must not be blank")
        return normalized


class ProjectSessionOpen(BaseModel):
    """Opens an existing workspace, optionally recovering a verified stale lock."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    recover_stale_lock: bool = False
    recovery_mode: Literal["cancel", "recover", "last_saved"] = "cancel"
    expected_lock_session_id: str | None = None
    remote_profile_id: str | None = None
    initialize_remote_storage: bool = False


class ProjectSessionSave(BaseModel):
    """Checkpoints one caller-observed project revision."""

    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=0)
    reason: Literal["manual", "autosave", "close", "migration"]


class ProjectSessionSaveAs(BaseModel):
    """Creates one portable copy from a caller-observed saved revision."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    expected_revision: int = Field(ge=0)
    identity: Literal["preserve", "regenerate"] = "preserve"
    replace_existing: bool = False


class ProjectSessionExit(BaseModel):
    """Saves a confirmed browser/desktop exit and releases session ownership."""

    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=0)


class ProjectCatalogEntry(BaseModel):
    """Read-only project metadata discovered inside one workspace directory."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    path: str = Field(min_length=1)
    format_version: int = Field(ge=1)
    updated_at: datetime


class ProjectCatalogResponse(BaseModel):
    """Resolved directory and its valid immediate child projects."""

    model_config = ConfigDict(extra="forbid")

    directory: str = Field(min_length=1)
    is_default: bool
    projects: list[ProjectCatalogEntry] = Field(default_factory=list)


class ProjectDirectoryEntry(BaseModel):
    """One navigable child exposed by the local directory picker."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    path: str = Field(min_length=1)


class ProjectDirectoryListingResponse(BaseModel):
    """One resolved directory level used for lazy tree navigation."""

    model_config = ConfigDict(extra="forbid")

    directory: str = Field(min_length=1)
    parent: str | None
    directories: list[ProjectDirectoryEntry] = Field(default_factory=list)


class ProjectSessionState(BaseModel):
    """Versioned runtime ownership and save-state projection."""

    model_config = ConfigDict(extra="forbid")

    session_version: Literal[1] = PROJECT_SESSION_VERSION
    session_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    project_path: str = Field(min_length=1)
    storage_mode: Literal["local_sqlite", "postgresql"]
    loaded_revision: int = Field(ge=0)
    saved_revision: int = Field(ge=0)
    save_status: Literal["clean", "dirty", "saving", "error"] = "clean"
    lifecycle: Literal["open", "closed"] = "open"
    opened_at: datetime
    last_saved_at: datetime | None = None
    save_error: str | None = None


class RemoteProjectSessionState(ProjectSessionState):
    """Negotiated remote authority; local v1 responses remain byte-compatible."""

    session_version: Literal[2] = 2
    remote_storage: RemoteStorageHeadV1
    remote_state: RemoteSessionState

    @model_validator(mode="after")
    def matching_authority(self):
        if (self.storage_mode != "postgresql" or self.remote_storage.project_id != self.project_id
                or self.remote_storage.state != self.remote_state):
            raise ValueError("remote_contract_invalid")
        return self


class ProjectSessionResponse(BaseModel):
    """Returns session ownership and one complete durable project document."""

    model_config = ConfigDict(extra="forbid")

    session: ProjectSessionState | RemoteProjectSessionState
    document: ProjectDocument


class ProjectSessionSaveAsResponse(BaseModel):
    """Reports the installed copy without transferring active session ownership."""

    model_config = ConfigDict(extra="forbid")

    source_session: ProjectSessionState | RemoteProjectSessionState
    destination_path: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    backup_path: str | None = None


class ProjectSessionErrorDetail(BaseModel):
    """Stable localization-ready error payload returned by session APIs."""

    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1)
    message_key: str = Field(min_length=1)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ProjectSessionErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: ProjectSessionErrorDetail
