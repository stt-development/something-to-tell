"""Test clients negotiate the same explicit remote guards as the browser client.

Negative protocol/guard tests intentionally use the unmodified TestClient instead.
No application fallback is enabled by this test-only adapter.
"""

import re
from uuid import uuid4
from fastapi.testclient import TestClient
from services.runtime.stt_runtime.project_session.remote_recovery import current_head


class GuardedTestClient(TestClient):
    def request(self, method, url, **kwargs):
        headers = dict(kwargs.pop("headers", None) or {})
        headers.setdefault("X-Remote-Storage-Version", "1")
        lowered = {key.lower(): value for key, value in headers.items()}
        payload = kwargs.get("json") or {}
        if not isinstance(payload, dict):
            payload = {}
        match = re.search(r"/project-sessions/([^/?]+)", str(url))
        sid = lowered.get("x-project-session-id") or payload.get("session_id") or (match.group(1) if match else None)
        registry = getattr(self.app.state, "project_sessions", None)
        active = registry._sessions.get(sid) if registry and sid else None
        if active and active.state.storage_mode == "postgresql" and method.upper() not in {"GET", "HEAD"}:
            headers.setdefault("X-Project-Session-Id", sid)
            value = current_head(registry, sid)
            for key, item in {
                "X-Remote-Storage-Generation": value.storage_generation, "X-Remote-Writer-Epoch": value.writer_epoch,
                "X-Remote-Expected-Revision": value.authoring_revision, "X-Remote-Command-Id": str(uuid4()),
            }.items():
                if key.lower() not in lowered:
                    headers[key] = item
        return super().request(method, url, headers=headers, **kwargs)
