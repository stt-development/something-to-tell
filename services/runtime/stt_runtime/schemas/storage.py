from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from ..project_format.manifest import StorageMode
from .project_session import ProjectSessionResponse
from .remote_storage import RemoteStorageFolderRequestV1

TlsPolicy = Literal["disable", "require", "verify-full"]


def _single_host(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 253 or "," in value or "\x00" in value or any(char.isspace() for char in value):
        raise ValueError("one hostname or IP address is required")
    return value


# Shared API/configuration validation; a failover list multiplies connect waits.
StorageHost = Annotated[str, Field(min_length=1), AfterValidator(_single_host)]


class StorageProfileSummary(BaseModel):
    """Secret-free application profile projection safe for frontend state."""

    model_config = ConfigDict(extra="forbid")

    profile_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    tls_policy: TlsPolicy


class StorageProfilesResponse(BaseModel):
    """Lists project-owned connection definitions without passwords."""

    model_config = ConfigDict(extra="forbid")

    profiles: list[StorageProfileSummary] = Field(default_factory=list)


class StorageProfileTestRequest(BaseModel):
    """Tests one opaque profile without accepting credentials from the browser."""

    model_config = ConfigDict(extra="forbid")

    session_id: str | None = Field(default=None, min_length=1)
    profile_id: str = Field(min_length=1)


class StorageProfileDefinitionRequest(BaseModel):
    """Connection fields shared by explicit session and pre-Open configuration."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1)
    host: StorageHost
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    tls_policy: TlsPolicy = "verify-full"


class StorageProfileCreateRequest(StorageProfileDefinitionRequest):
    """Existing open-project configuration, with its original wire fields."""

    session_id: str = Field(min_length=1)


class StorageFolderProfileCreateRequest(RemoteStorageFolderRequestV1, StorageProfileDefinitionRequest):
    """Explicit pre-Open configuration, not permission to use or change a DB."""


class StorageProfileTestResponse(BaseModel):
    """Reports connection capabilities using localization-ready values."""

    model_config = ConfigDict(extra="forbid")

    profile: StorageProfileSummary
    connected: bool
    tls_active: bool
    schema_status: Literal["current", "empty"]
    schema_revision: str | None
    permissions_valid: bool


class StorageMigrationRequest(BaseModel):
    """Copies one clean session to a selected storage authority."""

    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=1)
    expected_revision: int = Field(ge=0)
    target_mode: StorageMode
    target_profile_id: str | None = None


class StorageMigrationResponse(BaseModel):
    """Returns the switched session only after checksum verification."""

    model_config = ConfigDict(extra="forbid")

    source_mode: StorageMode
    target_mode: StorageMode
    verified_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    record_count: int = Field(ge=0)
    project: ProjectSessionResponse
