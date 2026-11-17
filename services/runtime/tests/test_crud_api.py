from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from services.runtime.stt_runtime.api.dependencies import get_uow
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    import_model_metadata()
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    app = create_app()

    def override_uow() -> Generator[SqlAlchemyUnitOfWork, None, None]:
        with SqlAlchemyUnitOfWork(session_factory) as uow:
            yield uow

    app.dependency_overrides[get_uow] = override_uow

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()


def create_project(client: TestClient) -> dict:
    response = client.post(
        "/api/projects",
        json={"name": "API Project", "path": "/tmp/API.narrative", "format_version": 1},
    )
    assert response.status_code == 201
    return response.json()


def create_node(client: TestClient, project_id: str, title: str = "Opening") -> dict:
    response = client.post(
        "/api/nodes",
        json={"project_id": project_id, "type": "Scene", "title": title},
    )
    assert response.status_code == 201
    return response.json()


def test_project_crud_api(client: TestClient) -> None:
    project = create_project(client)

    assert client.get(f"/api/projects/{project['id']}").json()["name"] == "API Project"
    assert len(client.get("/api/projects").json()) == 1

    update_response = client.put(
        f"/api/projects/{project['id']}",
        json={
            "name": "API Project Revised",
            "path": "/tmp/API-Revised.narrative",
            "format_version": 1,
            "metadata": {"genre": "rpg"},
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["metadata"] == {"genre": "rpg"}

    delete_response = client.delete(f"/api/projects/{project['id']}")
    assert delete_response.status_code == 204
    assert client.get(f"/api/projects/{project['id']}").status_code == 404


def test_node_and_edge_crud_api(client: TestClient) -> None:
    project = create_project(client)
    first_node = create_node(client, project["id"], "Opening")
    second_node = create_node(client, project["id"], "Embargo")

    edge_response = client.post(
        "/api/edges",
        json={
            "project_id": project["id"],
            "source_node_id": first_node["id"],
            "target_node_id": second_node["id"],
            "type": "reveals",
            "label": "reveals",
        },
    )
    assert edge_response.status_code == 201
    edge = edge_response.json()

    assert len(client.get(f"/api/nodes?project_id={project['id']}").json()) == 2
    assert len(client.get(f"/api/edges?project_id={project['id']}").json()) == 1

    node_update = client.put(
        f"/api/nodes/{first_node['id']}",
        json={"project_id": project["id"], "type": "Scene", "title": "Opening Revised"},
    )
    assert node_update.status_code == 200
    assert node_update.json()["title"] == "Opening Revised"

    edge_update = client.put(
        f"/api/edges/{edge['id']}",
        json={
            "project_id": project["id"],
            "source_node_id": first_node["id"],
            "target_node_id": second_node["id"],
            "type": "depends_on",
        },
    )
    assert edge_update.status_code == 200
    assert edge_update.json()["type"] == "depends_on"

    assert client.delete(f"/api/edges/{edge['id']}").status_code == 204
    assert client.delete(f"/api/nodes/{first_node['id']}").status_code == 204


def test_issue_suggestion_and_engine_tag_crud_api(client: TestClient) -> None:
    project = create_project(client)
    node = create_node(client, project["id"])

    issue = client.post(
        "/api/issues",
        json={"project_id": project["id"], "node_id": node["id"], "title": "Continuity warning"},
    ).json()
    suggestion = client.post(
        "/api/suggestions",
        json={"project_id": project["id"], "title": "Patch proposal", "patch": {"operations": []}},
    ).json()
    engine_tag = client.post(
        "/api/engine-tags",
        json={
            "project_id": project["id"],
            "target_type": "node",
            "target_id": node["id"],
            "engine": "unity",
            "key": "guid",
            "value": "unity-guid",
        },
    ).json()

    assert len(client.get(f"/api/issues?project_id={project['id']}").json()) == 1
    assert len(client.get(f"/api/suggestions?project_id={project['id']}").json()) == 1
    assert len(client.get(f"/api/engine-tags?project_id={project['id']}").json()) == 1

    assert client.put(
        f"/api/issues/{issue['id']}",
        json={"project_id": project["id"], "node_id": node["id"], "title": "Continuity warning", "status": "resolved"},
    ).json()["status"] == "resolved"
    assert client.put(
        f"/api/suggestions/{suggestion['id']}",
        json={"project_id": project["id"], "title": "Patch proposal", "status": "approved", "patch": {"operations": []}},
    ).json()["status"] == "approved"
    assert client.put(
        f"/api/engine-tags/{engine_tag['id']}",
        json={
            "project_id": project["id"],
            "target_type": "node",
            "target_id": node["id"],
            "engine": "unity",
            "key": "guid",
            "value": "updated-guid",
        },
    ).json()["value"] == "updated-guid"

    assert client.delete(f"/api/issues/{issue['id']}").status_code == 204
    assert client.delete(f"/api/suggestions/{suggestion['id']}").status_code == 204
    assert client.delete(f"/api/engine-tags/{engine_tag['id']}").status_code == 204


def test_crud_api_returns_stable_not_found_error(client: TestClient) -> None:
    response = client.get("/api/projects/missing")

    assert response.status_code == 404
    assert response.json() == {
        "detail": {
            "code": "project_not_found",
            "message": "Project not found: missing",
        }
    }


def test_crud_api_returns_stable_validation_error(client: TestClient) -> None:
    response = client.post(
        "/api/projects",
        json={"name": "", "path": "/tmp/API.narrative", "format_version": 1},
    )

    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"
    assert response.json()["detail"][0]["field"] == "body.name"


def test_crud_api_rejects_invalid_relationships(client: TestClient) -> None:
    project = create_project(client)
    node = create_node(client, project["id"])

    response = client.post(
        "/api/edges",
        json={
            "project_id": project["id"],
            "source_node_id": node["id"],
            "target_node_id": "missing-node",
            "type": "reveals",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "node_not_found"
