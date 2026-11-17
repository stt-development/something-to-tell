from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STT_RUNTIME_", env_file=".env", extra="ignore")

    database_url: str = Field(default="sqlite:///./project.sqlite")
    allowed_origins: tuple[str, ...] = Field(
        default=(
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "http://tauri.localhost",
            "tauri://localhost",
        )
    )
    docs_enabled: bool = Field(default=True)
    host: str = Field(default="127.0.0.1")
    port: int = Field(default=8719)
    reload: bool = Field(default=False)
    storage_profiles_file: Path = Field(
        default=Path("~/.narrative/storage-profiles.json")
    )
    storage_master_key_file: Path = Field(
        default=Path("~/.narrative/storage.key")
    )
    canon_provider_profiles_file: Path = Field(
        default=Path("~/.narrative/canon-provider-profiles.enc")
    )
    yarn_compiler_policy: Literal["disabled", "optional", "required"] = "optional"
    yarn_compiler_path: Path | None = None
    ink_compiler_policy: Literal["disabled", "optional", "required"] = "optional"
    ink_compiler_path: Path | None = None


@lru_cache(maxsize=1)
def get_settings() -> RuntimeSettings:
    return RuntimeSettings()
