"""Online backup includes committed WAL pages, unlike copying the main file."""

import sqlite3
from contextlib import closing


def backup_sqlite(source, destination):
    # Connection contexts finish transactions, but Windows rename needs handles closed.
    with closing(sqlite3.connect(source)) as read, closing(sqlite3.connect(destination)) as write:
        with read, write:
            read.backup(write)
