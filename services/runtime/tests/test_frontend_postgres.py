"""The browser resource helper borrows the established disposable DB owner."""

from contextlib import contextmanager
from io import StringIO
from types import SimpleNamespace

from services.runtime.scripts import frontend_postgres


def test_database_lifetime_follows_parent_input_without_logging_credentials(monkeypatch):
    events = []

    @contextmanager
    def database():
        events.append("created")
        try:
            yield SimpleNamespace(database="owned_generated", password="never-print")
        finally:
            events.append("dropped")

    monkeypatch.setattr(frontend_postgres, "disposable_database", database)
    output = StringIO()
    frontend_postgres.serve(StringIO(""), output)
    assert events == ["created", "dropped"]
    assert output.getvalue() == '{"database": "owned_generated"}\n'
