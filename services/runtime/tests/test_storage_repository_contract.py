"""Shared behavioral contract for every configured SQL storage dialect."""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime
import os

import pytest
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.domain.entities import NodeEntity, ProjectEntity
from services.runtime.stt_runtime.repositories.sqlite import (
    EntityNotFoundError,
    SqlAlchemyUnitOfWork,
)


def _storage_urls() -> list[object]:
    """Select available dialects without turning an absent opt-in service into a skip."""

    urls: list[pytest.ParamSpecArg] = [pytest.param("sqlite:///:memory:", id="sqlite")]
    postgres_url = os.getenv("STT_TEST_POSTGRES_URL")
    if postgres_url:
        urls.append(pytest.param(postgres_url, id="postgresql"))
    return urls


@pytest.fixture(params=_storage_urls())
def storage_engine(request: pytest.FixtureRequest) -> Iterator[Engine]:
    """Create an isolated schema for one implementation of the SQL storage contract."""

    import_model_metadata()
    engine = create_engine(request.param)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def _session_factory(engine: Engine) -> Callable[[], Session]:
    """Adapt an engine to the UnitOfWork factory contract."""

    return lambda: Session(engine)


def _project(identifier: str = "project-contract") -> ProjectEntity:
    """Build a stable project root shared by lifecycle assertions."""

    return ProjectEntity(
        id=identifier,
        name="Storage Contract",
        path="/tmp/StorageContract.narrative",
        format_version=2,
    )


def test_storage_repository_success_order_failure_and_lifecycle_contract(
    storage_engine: Engine,
) -> None:
    """Require every dialect to preserve CRUD, ordering, errors, and rollback."""

    session_factory = _session_factory(storage_engine)
    created_at = datetime(2026, 1, 1, tzinfo=UTC)
    project = _project()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        uow.projects.add(project)
        # Insert opposite to canonical id order to prove ordering is adapter-owned.
        uow.nodes.add(NodeEntity(
            id="node-b",
            project_id=project.id,
            type="Scene",
            title="Second",
            created_at=created_at,
        ))
        uow.nodes.add(NodeEntity(
            id="node-a",
            project_id=project.id,
            type="Scene",
            title="First",
            created_at=created_at,
        ))
        uow.commit()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        assert [node.id for node in uow.nodes.list(project_id=project.id)] == [
            "node-a",
            "node-b",
        ]
        with pytest.raises(EntityNotFoundError, match="node-missing"):
            uow.nodes.update(NodeEntity(
                id="node-missing",
                project_id=project.id,
                type="Event",
                title="Missing",
            ))

    rolled_back = _project("project-rolled-back")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        uow.projects.add(rolled_back)

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        assert uow.projects.get(rolled_back.id) is None
        assert uow.projects.get(project.id) == project
