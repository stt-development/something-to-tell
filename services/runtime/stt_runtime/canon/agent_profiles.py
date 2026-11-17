"""Encrypted machine-local credentials for optional Canon providers."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..schemas.canon_agent import CanonProvider, CanonProviderProfileSummary


class CanonProviderProfileError(ValueError):
    """Stable failure that never includes credential or provider response text."""

    def __init__(self, code: str, *, profile_id: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.profile_id = profile_id


class CanonProviderProfile(BaseModel):
    """Runtime-only provider material excluded from repr and every API response."""

    model_config = ConfigDict(extra="forbid")

    profile_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    provider: CanonProvider
    api_key: str = Field(min_length=8, repr=False)

    @field_validator("profile_id", "label", "api_key")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized

    def summary(self) -> CanonProviderProfileSummary:
        return CanonProviderProfileSummary(
            profile_id=self.profile_id,
            label=self.label,
            provider=self.provider,
        )


class _CanonProviderProfileBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profiles: list[CanonProviderProfile] = Field(default_factory=list)


class CanonProviderProfileRegistry:
    """Own the encrypted credential bundle under the desktop master key."""

    def __init__(self, bundle_file: Path, master_key_file: Path) -> None:
        self._bundle_file = bundle_file.expanduser()
        self._master_key_file = master_key_file.expanduser()

    def summaries(self) -> tuple[CanonProviderProfileSummary, ...]:
        return tuple(
            sorted(
                (profile.summary() for profile in self._read_profiles()),
                key=lambda item: (item.label.casefold(), item.profile_id),
            )
        )

    def resolve(self, profile_id: str) -> CanonProviderProfile:
        profile = next(
            (item for item in self._read_profiles() if item.profile_id == profile_id),
            None,
        )
        if profile is None:
            raise CanonProviderProfileError(
                "canon_provider_profile_unavailable",
                profile_id=profile_id,
            )
        return profile

    def add(
        self,
        *,
        label: str,
        provider: CanonProvider,
        api_key: str,
    ) -> CanonProviderProfile:
        profile = CanonProviderProfile(
            profile_id=f"canon-provider-{uuid4()}",
            label=label,
            provider=provider,
            api_key=api_key,
        )
        profiles = self._read_profiles()
        profiles.append(profile)
        self._write_profiles(profiles)
        return profile

    def remove(self, profile_id: str) -> None:
        profiles = self._read_profiles()
        retained = [item for item in profiles if item.profile_id != profile_id]
        if len(retained) == len(profiles):
            raise CanonProviderProfileError(
                "canon_provider_profile_unavailable",
                profile_id=profile_id,
            )
        self._write_profiles(retained)

    def replace(self, profile: CanonProviderProfile) -> None:
        """Atomically replace one encrypted profile after external verification."""

        profiles = self._read_profiles()
        if not any(item.profile_id == profile.profile_id for item in profiles):
            raise CanonProviderProfileError(
                "canon_provider_profile_unavailable",
                profile_id=profile.profile_id,
            )
        self._write_profiles([
            profile if item.profile_id == profile.profile_id else item
            for item in profiles
        ])

    def _read_profiles(self) -> list[CanonProviderProfile]:
        if not self._bundle_file.exists():
            return []
        try:
            decrypted = self._fernet(create=False).decrypt(self._bundle_file.read_bytes())
            return list(_CanonProviderProfileBundle.model_validate_json(decrypted).profiles)
        except (OSError, InvalidToken, ValidationError, ValueError) as error:
            raise CanonProviderProfileError("canon_provider_profile_bundle_invalid") from error

    def _write_profiles(self, profiles: list[CanonProviderProfile]) -> None:
        try:
            self._bundle_file.parent.mkdir(parents=True, exist_ok=True)
            payload = _CanonProviderProfileBundle(profiles=profiles).model_dump_json().encode()
            temporary = self._bundle_file.with_suffix(f"{self._bundle_file.suffix}.tmp")
            temporary.write_bytes(self._fernet(create=True).encrypt(payload))
            temporary.chmod(0o600)
            temporary.replace(self._bundle_file)
        except OSError as error:
            raise CanonProviderProfileError("canon_provider_profile_write_failed") from error

    def _fernet(self, *, create: bool) -> Fernet:
        if not self._master_key_file.exists():
            if not create:
                raise CanonProviderProfileError("canon_provider_profile_key_missing")
            try:
                self._master_key_file.parent.mkdir(parents=True, exist_ok=True)
                self._master_key_file.write_bytes(Fernet.generate_key())
                self._master_key_file.chmod(0o600)
            except OSError as error:
                raise CanonProviderProfileError("canon_provider_profile_key_write_failed") from error
        try:
            return Fernet(self._master_key_file.read_bytes())
        except (OSError, ValueError) as error:
            raise CanonProviderProfileError("canon_provider_profile_key_invalid") from error
