"""P5-007 API and concurrency coverage over the complete Project Aurora fixture."""

from pathlib import Path
from threading import Event
from time import sleep

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.impact import (
    ImpactDependencyTraversal,
    ImpactRunCoordinator,
)
from services.runtime.stt_runtime.project_document.patch import derive_project_patch
from services.runtime.stt_runtime.project_fixture import import_project_fixture

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
TERMINAL = {"completed", "failed", "cancelled", "stale"}


def test_create_poll_and_result_are_read_only_and_snapshot_bound(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        initial_history = client.get(
            f"/api/project-sessions/{session_id}/history"
        ).json()

        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        )
        assert created.status_code == 201
        assert created.json()["run"]["status"] == "queued"
        completed = _poll(client, session_id, created.json()["run"]["id"])

        assert completed["status"] == "completed"
        assert completed["findings"]
        assert completed["summary"]["finding_count"] == len(completed["findings"])
        assert completed["source_checksum"] == opened["document"]["checksum"]
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert inspected["document"]["checksum"] == opened["document"]["checksum"]
        assert inspected["session"]["saved_revision"] == opened["session"]["saved_revision"]
        assert inspected["session"]["save_status"] == "clean"
        assert history == initial_history


def test_completed_run_exposes_bounded_resolution_context_without_saving(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        ).json()["run"]
        completed = _poll(client, session_id, created["id"])
        selected = [item["id"] for item in completed["findings"][:3]]

        response = client.post(
            f"{_runs_path(session_id)}/{created['id']}/resolution-context",
            json={
                "impact_run_id": created["id"],
                "finding_ids": selected,
                "source_checksum": opened["document"]["checksum"],
                "provider_source": "project_default",
                "model_id": "structured-model",
                "content_consent": True,
            },
        )

        assert response.status_code == 200
        context = response.json()
        assert [item["id"] for item in context["findings"]] == sorted(
            selected,
            key=lambda finding_id: next(
                index for index, item in enumerate(completed["findings"])
                if item["id"] == finding_id
            ),
        )
        assert context["resources"]
        assert "document" not in context
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        assert inspected["session"]["save_status"] == "clean"
        assert inspected["document"]["checksum"] == opened["document"]["checksum"]


def test_missing_seed_and_target_limit_have_distinct_terminal_results(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]

        missing_response = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "missing-node"),
        ).json()
        missing = _poll(client, session_id, missing_response["run"]["id"])
        limited_response = client.post(
            _runs_path(session_id),
            json=_selection_request(
                opened,
                "node-opening",
                limits={"max_depth": 3, "max_paths_per_target": 3, "max_targets": 1},
            ),
        ).json()
        limited = _poll(client, session_id, limited_response["run"]["id"])

        assert missing["status"] == "failed"
        assert missing["findings"] == []
        assert missing["diagnostics"][0]["code"] == "impact_seed_not_found"
        assert limited["status"] == "completed"
        assert limited["summary"]["finding_count"] == 1
        assert limited["summary"]["truncated"] is True
        assert limited["summary"]["omitted_count"] > 0
        assert limited["diagnostics"][0]["code"] == "impact_result_limit_reached"


def test_patch_run_accepts_noop_and_rejects_invalid_patch_without_mutation(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        document = client.app.state.project_sessions.inspect(session_id).document
        noop = derive_project_patch(document, document).model_dump(mode="json")
        noop_request = _base_request(opened)
        noop_request["scenario"] = {"type": "patch", "patch": noop}

        created = client.post(_runs_path(session_id), json=noop_request)
        assert created.status_code == 201
        completed = _poll(client, session_id, created.json()["run"]["id"])
        assert completed["status"] == "completed"
        assert completed["findings"] == []

        invalid = dict(noop)
        invalid.update(
            {
                "patch_id": "project-patch-invalid-impact-api",
                "target_checksum": "e" * 64,
                "operations": [
                    {
                        "op": "remove_record",
                        "collection": "nodes",
                        "record_id": "missing-node",
                    }
                ],
            }
        )
        invalid_request = _base_request(opened)
        invalid_request["scenario"] = {"type": "patch", "patch": invalid}
        failed_response = client.post(_runs_path(session_id), json=invalid_request)
        assert failed_response.status_code == 201
        failed = _poll(client, session_id, failed_response.json()["run"]["id"])

        assert failed["status"] == "failed"
        assert failed["diagnostics"][0]["code"] == "impact_patch_invalid"
        assert client.get(f"/api/project-sessions/{session_id}").json()["document"][
            "checksum"
        ] == opened["document"]["checksum"]


def test_cancelled_run_publishes_no_partial_findings(tmp_path: Path) -> None:
    entered = Event()
    release = Event()
    app = create_app()
    with TestClient(app) as client:
        _replace_coordinator(app, lambda: _BlockingTraversal(entered, release))
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        ).json()["run"]
        assert entered.wait(timeout=5)
        assert client.get(f"{_runs_path(session_id)}/{created['id']}").json()["run"][
            "status"
        ] == "running"

        cancelled_request = client.post(
            f"{_runs_path(session_id)}/{created['id']}/cancel"
        )
        assert cancelled_request.status_code == 200
        release.set()
        cancelled = _poll(client, session_id, created["id"])

        assert cancelled["status"] == "cancelled"
        assert cancelled["findings"] == []
        assert cancelled["summary"]["finding_count"] == 0
        assert cancelled["diagnostics"][0]["code"] == "impact_run_cancelled"


def test_authoring_during_run_marks_it_stale_without_publishing(tmp_path: Path) -> None:
    entered = Event()
    release = Event()
    app = create_app()
    with TestClient(app) as client:
        _replace_coordinator(app, lambda: _BlockingTraversal(entered, release))
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        ).json()["run"]
        assert entered.wait(timeout=5)

        app.state.project_sessions.mark_dirty(session_id)
        release.set()
        stale = _poll(client, session_id, created["id"])

        assert stale["status"] == "stale"
        assert stale["findings"] == []
        assert stale["diagnostics"][0]["code"] == "impact_run_stale"


def test_save_during_run_cannot_publish_the_older_checksum(tmp_path: Path) -> None:
    entered = Event()
    release = Event()
    app = create_app()
    with TestClient(app) as client:
        _replace_coordinator(app, lambda: _BlockingTraversal(entered, release))
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        ).json()["run"]
        assert entered.wait(timeout=5)

        saved = app.state.project_sessions.save(
            session_id,
            expected_revision=opened["session"]["saved_revision"],
            reason="manual",
        )
        release.set()
        stale = _poll(client, session_id, created["id"])

        assert saved.session.saved_revision == opened["session"]["saved_revision"] + 1
        assert stale["status"] == "stale"
        assert stale["source_checksum"] == opened["document"]["checksum"]
        assert stale["findings"] == []


def test_stale_start_checkpoint_is_rejected_before_run_creation(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        stale_request = _selection_request(opened, "node-opening")
        stale_request["expected_history_revision"] = 99

        response = client.post(_runs_path(session_id), json=stale_request)

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "impact_run_stale"


def test_worker_failure_is_typed_and_contains_no_findings(tmp_path: Path) -> None:
    app = create_app()
    with TestClient(app) as client:
        _replace_coordinator(app, _FailingTraversal)
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        ).json()["run"]
        failed = _poll(client, session_id, created["id"])

        assert failed["status"] == "failed"
        assert failed["findings"] == []
        assert failed["diagnostics"][0]["code"] == "impact_run_failed"


def test_project_close_and_runtime_restart_evict_runs(tmp_path: Path) -> None:
    project_path = tmp_path / "ImpactRestart.narrative"
    import_project_fixture(FIXTURE, project_path)
    run_id: str
    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        ).json()
        session_id = opened["session"]["session_id"]
        created = client.post(
            _runs_path(session_id),
            json=_selection_request(opened, "node-opening"),
        ).json()["run"]
        run_id = created["id"]
        _poll(client, session_id, run_id)
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200
        assert client.get(f"{_runs_path(session_id)}/{run_id}").status_code == 404

    with TestClient(create_app()) as restarted:
        assert restarted.get(f"{_runs_path(session_id)}/{run_id}").status_code == 404


def test_terminal_run_retention_is_bounded_and_evicts_oldest(tmp_path: Path) -> None:
    app = create_app()
    with TestClient(app) as client:
        app.state.impact_runs.clear_all()
        app.state.impact_runs = ImpactRunCoordinator(
            app.state.project_sessions,
            max_retained_runs=2,
        )
        opened = _open_aurora(client, tmp_path)
        session_id = opened["session"]["session_id"]
        run_ids: list[str] = []
        for seed_id in ("node-opening", "node-hero", "node-harbor"):
            created = client.post(
                _runs_path(session_id),
                json=_selection_request(opened, seed_id),
            ).json()["run"]
            _poll(client, session_id, created["id"])
            run_ids.append(created["id"])

        assert client.get(f"{_runs_path(session_id)}/{run_ids[0]}").status_code == 404
        assert client.get(f"{_runs_path(session_id)}/{run_ids[1]}").status_code == 200
        assert client.get(f"{_runs_path(session_id)}/{run_ids[2]}").status_code == 200


class _BlockingTraversal:
    """Expose the coordinator's process-local cancellation and stale window."""

    def __init__(self, entered: Event, release: Event) -> None:
        self._entered = entered
        self._release = release
        self._delegate = ImpactDependencyTraversal()

    def traverse(self, *args, **kwargs):
        self._entered.set()
        assert self._release.wait(timeout=5)
        return self._delegate.traverse(*args, **kwargs)


class _FailingTraversal:
    def traverse(self, *args, **kwargs):
        raise RuntimeError("injected impact worker failure")


def _replace_coordinator(app, traversal_factory) -> None:
    app.state.impact_runs.clear_all()
    app.state.impact_runs = ImpactRunCoordinator(
        app.state.project_sessions,
        traversal_factory=traversal_factory,
    )


def _open_aurora(client: TestClient, tmp_path: Path) -> dict:
    project_path = tmp_path / "ImpactAurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    response = client.post("/api/project-sessions/open", json={"path": str(project_path)})
    assert response.status_code == 200
    return response.json()


def _base_request(opened: dict) -> dict[str, object]:
    return {
        "observed_saved_revision": opened["session"]["saved_revision"],
        "expected_history_revision": 0,
        "source_checksum": opened["document"]["checksum"],
        "direction": "downstream",
    }


def _selection_request(
    opened: dict,
    seed_id: str,
    **changes: object,
) -> dict[str, object]:
    payload = _base_request(opened)
    payload["scenario"] = {
        "type": "selection",
        "intent": "modify",
        "seeds": [{"resource": {"owner_type": "node", "owner_id": seed_id}}],
    }
    payload.update(changes)
    return payload


def _runs_path(session_id: str) -> str:
    return f"/api/project-sessions/{session_id}/impact-analysis/runs"


def _poll(client: TestClient, session_id: str, run_id: str) -> dict:
    for _ in range(300):
        response = client.get(f"{_runs_path(session_id)}/{run_id}")
        assert response.status_code == 200
        run = response.json()["run"]
        if run["status"] in TERMINAL:
            return run
        sleep(0.01)
    raise AssertionError(f"impact run did not finish: {run_id}")
