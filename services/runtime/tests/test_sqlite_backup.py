"""Backup connections must release file handles before checkpoint publication."""

from types import SimpleNamespace

import pytest

from services.runtime.stt_runtime.db import sqlite_backup


@pytest.mark.parametrize("failure", [None, "backup", "destination_connect"])
def test_backup_closes_every_owned_connection_before_return(monkeypatch, failure):
    events = []

    class Connection:
        def __init__(self, name):
            self.name = name

        def __enter__(self):
            events.append(("enter", self.name))
            return self

        def __exit__(self, *args):
            # sqlite3 transaction contexts commit/rollback, but do not close.
            events.append(("transaction_end", self.name))

        def backup(self, destination):
            events.append(("backup", destination.name))
            if failure == "backup":
                raise RuntimeError("backup failed")

        def close(self):
            events.append(("close", self.name))

    def connect(name):
        if name == "destination" and failure == "destination_connect":
            raise RuntimeError("connection failed")
        return Connection(name)

    monkeypatch.setattr(sqlite_backup, "sqlite3", SimpleNamespace(connect=connect))
    if failure:
        with pytest.raises(RuntimeError):
            sqlite_backup.backup_sqlite("source", "destination")
    else:
        sqlite_backup.backup_sqlite("source", "destination")
    expected = ["source"] if failure == "destination_connect" else ["destination", "source"]
    assert [name for event, name in events if event == "close"] == expected
    if failure != "destination_connect":
        assert events.index(("transaction_end", "destination")) < events.index(("close", "destination"))
