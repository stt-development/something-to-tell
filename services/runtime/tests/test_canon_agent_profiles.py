from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from services.runtime.stt_runtime.canon.agent_profiles import (
    CanonProviderProfile,
    CanonProviderProfileError,
    CanonProviderProfileRegistry,
)


def test_provider_profiles_are_encrypted_and_never_expose_api_keys(tmp_path: Path) -> None:
    bundle = tmp_path / "canon-provider-profiles.enc"
    key = tmp_path / "storage.key"
    secret = "sk-test-provider-secret"
    registry = CanonProviderProfileRegistry(bundle, key)

    created = registry.add(label="Writing account", provider="openai", api_key=secret)
    summary = created.summary()

    assert summary.label == "Writing account"
    assert summary.provider == "openai"
    assert "api_key" not in summary.model_dump()
    assert secret.encode() not in bundle.read_bytes()
    assert bundle.stat().st_mode & 0o777 == 0o600
    assert key.stat().st_mode & 0o777 == 0o600
    reopened = CanonProviderProfileRegistry(bundle, key).resolve(created.profile_id)
    assert reopened.api_key == secret
    assert secret not in repr(reopened)


def test_provider_profile_store_rejects_another_machine_key(tmp_path: Path) -> None:
    bundle = tmp_path / "canon-provider-profiles.enc"
    first_key = tmp_path / "first.key"
    registry = CanonProviderProfileRegistry(bundle, first_key)
    registry.add(label="Gemini", provider="google_gemini", api_key="AIza-test-secret")
    other_key = tmp_path / "other.key"
    other_key.write_bytes(Fernet.generate_key())

    with pytest.raises(CanonProviderProfileError) as caught:
        CanonProviderProfileRegistry(bundle, other_key).summaries()

    assert caught.value.code == "canon_provider_profile_bundle_invalid"


def test_provider_profile_can_be_atomically_replaced_and_removed(tmp_path: Path) -> None:
    registry = CanonProviderProfileRegistry(tmp_path / "profiles.enc", tmp_path / "key")
    created = registry.add(label="Old", provider="openai", api_key="sk-old-secret")
    replacement = CanonProviderProfile(
        profile_id=created.profile_id,
        label="Claude account",
        provider="anthropic",
        api_key="sk-ant-new-secret",
    )

    registry.replace(replacement)

    assert registry.resolve(created.profile_id) == replacement
    registry.remove(created.profile_id)
    with pytest.raises(CanonProviderProfileError) as caught:
        registry.resolve(created.profile_id)
    assert caught.value.code == "canon_provider_profile_unavailable"
