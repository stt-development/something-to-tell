"""Offline reset has no route, retry or implicit fence/credential mutation."""

import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from services.runtime.scripts import reset_restored_storage as cli
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.storage_restore import reset_restored_generations


@pytest.mark.parametrize("confirmed,database", [(False, "target"), ("true", "target"), (True, "")])
def test_explicit_operator_confirmation_precedes_database_access(confirmed, database):
    engine = Mock()
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        reset_restored_generations(engine, expected_database=database, confirmed=confirmed)
    engine.connect.assert_not_called()


@pytest.mark.parametrize("url", [None, "sqlite:///private-secret", "not-a-url-private-secret"])
def test_cli_never_prints_configuration_or_driver_errors(monkeypatch, capsys, url):
    monkeypatch.setattr("sys.argv", ["restore", "--expected-database", "target", "--confirm-isolated-restore"])
    if url is None:
        monkeypatch.delenv("STT_RESTORE_DATABASE_URL", raising=False)
    else:
        monkeypatch.setenv("STT_RESTORE_DATABASE_URL", url)
    assert cli.main() == 1
    result = capsys.readouterr()
    assert json.loads(result.out) == {"status": "failed", "code": "restore_failed"}
    assert "private-secret" not in result.out + result.err


@pytest.mark.parametrize("unknown", [False, True])
def test_cli_defaults_to_verified_tls_and_never_retries_unknown_commit(monkeypatch, capsys, unknown):
    monkeypatch.setattr("sys.argv", ["restore", "--expected-database", "target", "--confirm-isolated-restore"])
    monkeypatch.setenv("STT_RESTORE_DATABASE_URL", "postgresql+psycopg://operator:private-secret@invalid/target")
    engine = Mock()
    create = Mock(return_value=engine)
    reset = Mock(side_effect=ProjectSessionError("remote_commit_unknown")) if unknown else Mock(
        return_value={"projects": 2, "copied_checkpoints": 4, "maintenance": True})
    monkeypatch.setattr(cli, "create_engine", create)
    monkeypatch.setattr(cli, "reset_restored_generations", reset)
    assert cli.main() == int(unknown)
    assert create.call_args.args[0].query["sslmode"] == "verify-full"
    assert create.call_args.kwargs["connect_args"]["connect_timeout"] == 5
    reset.assert_called_once_with(engine, expected_database="target", confirmed=True)
    engine.dispose.assert_called_once()
    output = capsys.readouterr().out
    assert "private-secret" not in output
    assert json.loads(output)["status"] == ("failed" if unknown else "ok")


@pytest.mark.internal_documentation
def test_native_drill_archive_is_complete_redacted_and_not_desktop_evidence():
    path = Path(__file__).resolve().parents[3] / "docs/verification/baselines/p9-010-native-restore-v1.json"
    report = json.loads(path.read_text())
    assert report["status"] == "ok" and report["database_cleanup"] == "released"
    assert report["projects"] == 2 and report["canonical_nodes"] == 32
    assert report["tools"] == {"pg_dump": "17.10", "pg_restore": "17.10"}
    assert all(report["invariants"].values())
    assert report["invariants"]["ordinary_reopen_after_rebind"] is True
    for private in ("password", "postgresql+psycopg", "owner_token", "/Users/"):
        assert private not in path.read_text()
