"""Freeze recipe and offline self-check do not read projects or require a server."""

import asyncio
from hashlib import sha256
import json
from pathlib import Path

import pytest

from services.runtime import desktop_entry
from services.runtime.scripts import build_desktop_runtime as bundle


def test_recipe_is_one_directory_and_allowlists_package_resources_not_user_data(tmp_path):
    arguments = bundle.build_arguments(tmp_path / "dist", tmp_path / "build")
    assert "--onedir" in arguments and "--onefile" not in arguments
    assert "--noupx" in arguments
    data = [arguments[index + 1] for index, value in enumerate(arguments) if value == "--add-data"]
    assert any(value.endswith("alembic.ini:services/runtime") for value in data)
    assert any("migrations/env.py:" in value for value in data)
    assert any("20261022_0012" in value for value in data)
    assert all("__pycache__" not in value and ".env" not in value for value in data)
    assert all("/docs/" not in value and "/tests/" not in value for value in data)
    assert arguments[-1].endswith("services/runtime/desktop_entry.py")
    metadata = [arguments[index + 1] for index, value in enumerate(arguments) if value == "--recursive-copy-metadata"]
    assert "sqlalchemy" in metadata and "psycopg" in metadata
    assert "pytest" not in metadata and "pyinstaller" not in metadata


def test_manifest_records_bytes_and_internal_symlinks_without_absolute_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle, "version", lambda package: "test-version")
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    (candidate / "library").write_bytes(b"runtime-library")
    (candidate / "alias").symlink_to("library")
    report = bundle.artifact_manifest(candidate)
    assert report["files"] == [
        {"path": "alias", "symlink": "library"},
        {"path": "library", "bytes": 15, "sha256": sha256(b"runtime-library").hexdigest()},
    ]
    assert str(tmp_path) not in json.dumps(report)
    assert report["runtime_dependencies"]["psycopg"] == "test-version"
    assert any(row["path"] == "services/runtime/desktop_entry.py" for row in report["sources"])
    assert all(not Path(row["path"]).is_absolute() for row in report["sources"])


def test_manifest_rejects_symlink_to_outside_bundle(tmp_path):
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    outside = tmp_path / "private"
    outside.write_text("private")
    (candidate / "alias").symlink_to(outside)
    with pytest.raises(ValueError, match="runtime_bundle_external_symlink"):
        bundle.artifact_manifest(candidate)


def test_offline_self_check_round_trips_only_owned_temporary_project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("STT_RUNTIME_STORAGE_PROFILES_FILE", str(tmp_path / "must-not-read.json"))
    (tmp_path / "must-not-read.json").write_text("invalid private registry")
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    stages = []
    report = asyncio.run(desktop_entry.self_check(stages.append))
    assert report["status"] == "ok" and "reopen" in report["checks"]
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
    assert stages == ["temporary_directory", "create_app", "lifespan_start", "create", "edit", "save",
                      "close", "reopen", "round_trip", "reopen_close", "lock_release", "lifespan_stop",
                      "profile_isolation", "temporary_cleanup"]


def test_failed_cli_probe_emits_only_stable_error(monkeypatch, capsys):
    async def failure(progress=None):
        raise RuntimeError("private-token-and-path")
    monkeypatch.setattr(desktop_entry, "self_check", failure)
    assert desktop_entry.main(["--self-check"]) == 1
    output = capsys.readouterr()
    assert json.loads(output.out)["code"] == "runtime_self_check_failed"
    assert "private-token-and-path" not in output.out + output.err


@pytest.mark.parametrize("stage", ["create", "save", "temporary_cleanup", "private-stage-and-path"])
def test_probe_diagnostics_disclose_only_fixed_stage_and_error_categories(monkeypatch, capsys, stage):
    async def failure(progress):
        progress(stage)
        try:
            raise FileNotFoundError("private-path-and-key")
        except FileNotFoundError as cause:
            raise PermissionError("private-token-and-project") from cause

    monkeypatch.setattr(desktop_entry, "self_check", failure)
    assert desktop_entry.main(["--self-check"]) == 1
    output = capsys.readouterr()
    assert json.loads(output.out) == {
        "schema_version": 1, "status": "failed", "code": "runtime_self_check_failed",
        "stage": stage if stage in desktop_entry.SELF_CHECK_STAGES else "unknown",
        "error_types": ["PermissionError", "FileNotFoundError"],
    }
    assert "private-" not in output.out + output.err


def test_probe_error_categories_are_bounded_and_reject_custom_type_names():
    private_error = type("PrivateTokenAndPath", (Exception,), {})
    error = private_error("private-data")
    for _ in range(8):
        wrapped = RuntimeError("private-data")
        wrapped.__cause__ = error
        error = wrapped
    assert desktop_entry._probe_error_types(error) == ["RuntimeError"] * 5
    assert desktop_entry._probe_error_types(private_error()) == ["other"]
