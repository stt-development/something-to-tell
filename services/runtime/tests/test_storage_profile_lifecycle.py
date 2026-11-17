"""Additive profile configuration cannot edit an engine/authority already in use."""

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.stt_runtime.project_format.service import create_project_folder, PROJECT_CONFIG_FILE
from services.runtime.tests.test_profile_connection_policy import registry


@pytest.mark.parametrize("field,value", [("password", "new-secret"), ("host", "other.example"), ("tls_policy", "disable")])
def test_resolved_profile_is_immutable(field, value):
    profile = registry().resolve("policy")
    with pytest.raises(ValidationError, match="frozen_instance"):
        setattr(profile, field, value)


def test_new_encrypted_definition_preserves_old_engine_profile_and_local_binding(tmp_path):
    folder = create_project_folder(tmp_path / "Local.narrative").path
    marker = folder / PROJECT_CONFIG_FILE
    before = marker.read_bytes()
    profiles = registry(); profiles._master_key_file = tmp_path / "machine.key"
    old = profiles.resolve("policy")
    engine = profiles.create_engine("policy", folder)
    try:
        created = profiles.add(folder, label="Replacement candidate", host="other.example", port=6543,
            database="other", username="other-user", password="new-secret", tls_policy="verify-full")
        assert created.profile_id != old.profile_id
        assert profiles.resolve("policy", folder) == old
        assert engine.url == old.database_url()
        assert engine.url.password == old.password
        assert marker.read_bytes() == before
        reloaded = StorageProfileRegistry([old], master_key_file=profiles._master_key_file)
        assert reloaded.resolve(created.profile_id, folder).password == "new-secret"
        assert {p.profile_id for p in reloaded.summaries(folder)} == {old.profile_id, created.profile_id}
    finally:
        engine.dispose()
