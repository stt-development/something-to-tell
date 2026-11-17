"""Inert release DTOs share golden wire with TypeScript; no lifecycle execution."""

import json
from pathlib import Path

from pydantic import ValidationError
import pytest

from services.runtime.stt_runtime.schemas.remote_storage import RemoteStorageReleaseV1, RemoteStorageReleaseResultV1

SAMPLES = json.loads((Path(__file__).parent / "fixtures/remote_storage_v1.json").read_text())


@pytest.mark.parametrize("name,model", [("release_request", RemoteStorageReleaseV1), ("release_result", RemoteStorageReleaseResultV1)])
def test_golden_release_is_exact_and_immutable(name, model):
    value = model.model_validate_json(json.dumps(SAMPLES[name]))
    assert json.loads(value.model_dump_json()) == SAMPLES[name]
    with pytest.raises(ValidationError):
        value.protocol_version = 1


@pytest.mark.parametrize("override", [{"confirmation": False}, {"confirmation": "save"}, {"confirmation": None},
    {"storage_generation": "bad"}, {"storage_generation": SAMPLES["head"]["storage_generation"] + "\n"},
    {"protocol_version": True}, {"protocol_version": 2}, {"password": "secret"}, {"force_unlock": True}, {"observed_revision": 4}])
def test_release_request_refuses_coercion_secrets_and_implicit_destructive_intent(override):
    with pytest.raises(ValidationError):
        RemoteStorageReleaseV1.model_validate_json(json.dumps(SAMPLES["release_request"] | override))


def test_version_and_confirmation_are_required_in_release_request():
    for key in ("protocol_version", "confirmation", "storage_generation"):
        with pytest.raises(ValidationError):
            RemoteStorageReleaseV1.model_validate_json(json.dumps({k: v for k, v in SAMPLES["release_request"].items() if k != key}))


@pytest.mark.parametrize("override", [{"status": "saved"}, {"status": "released"}, {"save_status": "clean"},
    {"document": {}}, {"session_id": ""}, {"project_id": "project-a\n"}, {"session_id": "session-a\n"},
    {"storage_generation": "bad"}, {"protocol_version": True}, {"owner_token": "private"}])
def test_release_result_cannot_claim_a_document_save_or_private_owner(override):
    with pytest.raises(ValidationError):
        RemoteStorageReleaseResultV1.model_validate_json(json.dumps(SAMPLES["release_result"] | override))
