"""Tracked reconnect golden wire is strict, inert and shared with TypeScript."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.remote_storage import (
    RemoteReconnectBeginV1, RemoteReconnectAbandonV1, RemoteReconnectOutcomeV1,
)

SAMPLES = json.loads((Path(__file__).parent / "fixtures/remote_reconnect_v1.json").read_text())
MODELS = {"begin": RemoteReconnectBeginV1, "abandon": RemoteReconnectAbandonV1, "outcome": RemoteReconnectOutcomeV1}


@pytest.mark.parametrize("name", MODELS)
def test_shared_wire_is_exact_frozen_and_requires_every_field(name):
    model = MODELS[name]
    value = model.model_validate(SAMPLES[name])
    assert value.model_dump() == SAMPLES[name]
    with pytest.raises(ValidationError):
        value.attempt_id = SAMPLES[name]["attempt_id"]
    for key in SAMPLES[name]:
        with pytest.raises(ValidationError):
            model.model_validate({k: v for k, v in SAMPLES[name].items() if k != key})


@pytest.mark.parametrize("name", MODELS)
@pytest.mark.parametrize("override", [{"protocol_version": True}, {"protocol_version": 2},
    {"project_id": "a\n"}, {"attempt_id": "invalid"}, {"storage_generation": "invalid"},
    {"owner_token": "secret"}, {"document": {}}, {"save_status": "clean"}])
def test_unsafe_scope_and_extra_authority_are_rejected(name, override):
    with pytest.raises(ValidationError):
        MODELS[name].model_validate(SAMPLES[name] | override)


@pytest.mark.parametrize("override", [{"observed_revision": 1}, {"observed_revision": "9223372036854775808"},
    {"unresolved_command_id": "bad"}, {"confirmation": "save"}, {"confirmation": True}])
def test_begin_requires_precise_counter_and_reload_consent(override):
    with pytest.raises(ValidationError):
        RemoteReconnectBeginV1.model_validate(SAMPLES["begin"] | override)


@pytest.mark.parametrize("status", ["unknown", "pending", "ready", "failed", "releasing", "release_failed", "released"])
def test_outcomes_only_expose_candidate_and_error_when_meaningful(status):
    candidate = "session-new" if status in {"ready", "release_failed"} else None
    error = "remote_storage_unavailable" if status in {"failed", "release_failed"} else None
    value = SAMPLES["outcome"] | dict(status=status, result_session_id=candidate, error_code=error)
    assert RemoteReconnectOutcomeV1.model_validate(value).status == status
    for key, invalid in [("result_session_id", None if candidate else "session-new"),
                         ("error_code", None if error else "remote_storage_unavailable")]:
        with pytest.raises(ValidationError):
            RemoteReconnectOutcomeV1.model_validate(value | {key: invalid})


@pytest.mark.parametrize("override", [{"result_session_id": "session-old"}, {"status": "saved"},
    {"error_code": "secret driver text"}, {"result_session_id": ""}])
def test_result_never_aliases_source_or_contains_driver_prose(override):
    with pytest.raises(ValidationError):
        RemoteReconnectOutcomeV1.model_validate(SAMPLES["outcome"] | override)
