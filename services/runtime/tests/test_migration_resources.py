"""Source and frozen-like layouts share exactly one read-only migration chain."""

from hashlib import sha256
from pathlib import Path
import shutil

from alembic import command
from alembic.script import ScriptDirectory
import pytest
from sqlalchemy import create_engine, inspect, text

from services.runtime.stt_runtime import migration_resources as resources
from services.runtime.stt_runtime.project_session.database import alembic_config
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


def inventory(root):
    return {str(path.relative_to(root)): sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file() and "__pycache__" not in path.parts}


@pytest.fixture
def installed(tmp_path, monkeypatch):
    source = Path(resources.files("services.runtime"))
    root = tmp_path / "Приложение 100%" / "_internal/services/runtime"
    root.mkdir(parents=True)
    shutil.copyfile(source / "alembic.ini", root / "alembic.ini")
    shutil.copytree(source / "migrations", root / "migrations", ignore=shutil.ignore_patterns("__pycache__"))
    monkeypatch.setattr(resources, "files", lambda package: root)
    # Installed application resources are not a writable project directory.
    for path in root.rglob("*"):
        path.chmod(0o555 if path.is_dir() else 0o444)
    root.chmod(0o555)
    try:
        yield root
    finally:
        root.chmod(0o755)
        for path in root.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)


def test_source_and_both_adapters_resolve_identical_chain_from_unrelated_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    local = alembic_config("sqlite:///:memory:")
    remote = StorageProfileRegistry._alembic_config()
    assert local.get_main_option("script_location") == remote.get_main_option("script_location")
    assert Path(local.get_main_option("script_location")).is_absolute()
    assert local.get_main_option("prepend_sys_path") == ""
    chain = ScriptDirectory.from_config(local)
    assert chain.get_current_head() == ScriptDirectory.from_config(remote).get_current_head()
    assert len(list(chain.walk_revisions())) > 1


def test_frozen_like_read_only_resources_upgrade_real_database_without_changes(installed, tmp_path, monkeypatch):
    before = inventory(installed)
    working = tmp_path / "unrelated"
    working.mkdir()
    monkeypatch.chdir(working)
    url = f"sqlite:///{tmp_path / 'История 100%.sqlite'}"
    config = alembic_config(url)
    assert config.get_main_option("sqlalchemy.url") == url
    command.upgrade(config, "head")
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == ScriptDirectory.from_config(config).get_current_head()
            assert "nodes" in inspect(connection).get_table_names()
    finally:
        engine.dispose()
    assert inventory(installed) == before
    assert list(working.iterdir()) == []


@pytest.mark.parametrize("missing", ["alembic.ini", "migrations/env.py", "migrations/versions"])
def test_incomplete_resources_fail_before_migration_without_checkout_fallback(tmp_path, monkeypatch, missing):
    source = Path(resources.files("services.runtime"))
    root = tmp_path / "partial"
    shutil.copytree(source / "migrations", root / "migrations")
    shutil.copyfile(source / "alembic.ini", root / "alembic.ini")
    path = root / missing
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    monkeypatch.setattr(resources, "files", lambda package: root)
    for create in (lambda: alembic_config("sqlite:///:memory:"), StorageProfileRegistry._alembic_config):
        with pytest.raises(RuntimeError, match="^runtime_migration_resources_unavailable$"):
            create()


def test_unsupported_non_directory_resource_loader_is_explicit(monkeypatch):
    monkeypatch.setattr(resources, "files", lambda package: object())
    with pytest.raises(RuntimeError, match="^runtime_migration_resources_unavailable$"):
        resources.migration_config()


def test_remote_url_interpolation_preserves_encoded_password_without_connecting():
    url = "postgresql+psycopg://user:pass%25word@invalid.example/database"
    config = resources.migration_config(url)
    assert config.get_main_option("sqlalchemy.url") == url
