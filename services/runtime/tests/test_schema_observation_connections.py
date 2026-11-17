"""Borrowed observations keep transaction ownership out of the SQL readers."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import OperationalError

from services.runtime.stt_runtime import storage_inspection
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plan_context import capture_schema_plan_context_connection
from services.runtime.stt_runtime.storage_inspection import inspect_storage_connection, storage_profile_engine
from services.runtime.tests.test_storage_inspection_api import composition


@pytest.mark.parametrize("reader", ["inspection", "context"])
def test_inactive_connection_rejected_without_implicit_begin(reader):
    connection = Mock()
    connection.in_transaction.return_value = False
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        if reader == "inspection":
            inspect_storage_connection(connection, Mock(), "disable")
        else:
            capture_schema_plan_context_connection(connection, Mock(), Mock(), "audit", Mock())
    connection.scalar.assert_not_called()
    connection.execute.assert_not_called()
    connection.begin.assert_not_called()
    connection.commit.assert_not_called()
    connection.rollback.assert_not_called()
    connection.close.assert_not_called()


@pytest.mark.parametrize("tls,policy,code", [(False, "disable", None), (False, "verify-full", "remote_tls_failed")])
def test_borrowed_inspection_never_opens_snapshot_or_finalizes(composition, monkeypatch, tls, policy, code):
    profiles, _, engine, connection = composition
    connection.scalar.side_effect = [170010, tls]
    snapshot = Mock(side_effect=AssertionError("reader opened snapshot"))
    monkeypatch.setattr(storage_inspection, "schema_snapshot", snapshot)
    if code:
        with pytest.raises(ProjectSessionError, match=code):
            inspect_storage_connection(connection, Mock(), policy)
    else:
        result = inspect_storage_connection(connection, Mock(), policy)
        assert result.schema_status == "current" and result.privileges == "runtime"
    snapshot.assert_not_called()
    connection.begin.assert_not_called()
    connection.commit.assert_not_called()
    connection.rollback.assert_not_called()
    connection.close.assert_not_called()
    engine.dispose.assert_not_called()


def test_profile_owner_does_not_own_a_transaction(composition):
    profiles, profile, engine, _ = composition
    with storage_profile_engine(profiles, Path("/unused"), "audit") as (borrowed, resolved, scripts):
        assert borrowed is engine and resolved is profile
        assert scripts.get_current_head()
        engine.connect.assert_not_called()
        engine.dispose.assert_not_called()
    engine.dispose.assert_called_once()


@pytest.mark.parametrize("state,code", [("42501", "remote_admin_required"), ("57014", "remote_storage_timeout"),
    (None, "remote_storage_unavailable")])
def test_profile_owner_redacts_errors_from_borrower_and_disposes(composition, state, code):
    profiles, _, engine, _ = composition
    class DriverFailure(Exception):
        sqlstate = state
    with pytest.raises(ProjectSessionError) as caught:
        with storage_profile_engine(profiles, Path("/unused"), "audit"):
            raise OperationalError(None, None, DriverFailure("password=never-return /secret/path"))
    assert caught.value.code == code and caught.value.parameters == {}
    assert "never-return" not in str(caught.value)
    engine.dispose.assert_called_once()
