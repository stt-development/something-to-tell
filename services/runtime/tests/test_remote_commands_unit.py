"""Pure canonical intent and cache-contract checks without database/network access."""

from hashlib import sha256
import json
from uuid import uuid4

import pytest
from services.runtime.stt_runtime.project_session.remote_store import digest
from services.runtime.stt_runtime.project_session.remote_files import read_binding
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schemas.remote_storage import RemoteCommandGuardV1


def test_digest_is_utf8_canonical_and_excludes_writer_epoch():
    guard = RemoteCommandGuardV1(project_id="p", storage_generation=str(uuid4()), command_id=str(uuid4()),
        writer_epoch="7", expected_revision="9007199254740993")
    payload = {"title": "\u0421\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u0434\u0432\u0435\u0440\u044c", "optional": None, "nested": {"b": 2, "a": 1}}
    expected = dict(protocol_version=1, project_id="p", storage_generation=guard.storage_generation,
        expected_revision=guard.expected_revision, kind="update", target={"node_id": "n"}, payload=payload)
    canonical = json.dumps(expected, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    assert digest(guard, "update", {"node_id": "n"}, payload) == sha256(canonical.encode("utf-8")).hexdigest()
    assert digest(guard, "update", {}, payload) == digest(guard.model_copy(update={"writer_epoch": "8"}), "update", {}, payload)
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        digest(guard, "update", {}, {"x": float("nan")})


@pytest.mark.parametrize("override", [{"binding_version": True}, {"owner_token": "secret"},
    {"observed_revision": 1}, {"observed_revision": "01"}, {"observed_revision": "9223372036854775808"},
    {"storage_generation": "not-a-generation"}])
def test_binding_rejects_unknown_secret_or_coerced_fields(tmp_path, override):
    cache = tmp_path / "cache"
    cache.mkdir()
    value = dict(binding_version=1, project_id="p", profile_id="audit", storage_generation=str(uuid4()), observed_revision="0")
    (cache / "remote-binding.json").write_text(json.dumps({**value, **override}))
    with pytest.raises(ProjectSessionError, match="remote_storage_binding_required"):
        read_binding(tmp_path, "p")


def test_canon_projection_retains_the_head_captured_under_the_write_guard(tmp_path, monkeypatch):
    """Pure projection can run after unlocking, but cannot adopt a later head."""
    from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
    from services.runtime.stt_runtime.canon.projection import CanonFactProjector
    from services.runtime.stt_runtime.schemas.remote_storage import RemoteStorageHeadV1
    registry = ProjectSessionRegistry()
    try:
        opened = registry.create(tmp_path / "Capture.narrative", "Capture")
        sid = opened.session.session_id
        active = registry._sessions[sid]
        before = RemoteStorageHeadV1(project_id=opened.session.project_id, storage_generation=str(uuid4()),
            authoring_revision="1", saved_authoring_revision="0", saved_revision="0", writer_epoch="1",
            document_checksum=opened.document.checksum, state="ready")
        active.remote_head = before
        project = CanonFactProjector.project
        def interleave(self, *args, **kwargs):
            active.remote_head = before.model_copy(update={"authoring_revision": "2"})
            return project(self, *args, **kwargs)
        monkeypatch.setattr(CanonFactProjector, "project", interleave)
        captured = registry.capture_canon_input(sid)
        assert captured.remote_storage == before
        assert active.remote_head.authoring_revision == "2"
    finally:
        registry.close_all()
