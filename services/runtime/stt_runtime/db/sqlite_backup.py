"""Online backup includes committed WAL pages, unlike copying the main file."""

import sqlite3


def backup_sqlite(source, destination):
    with sqlite3.connect(source) as read, sqlite3.connect(destination) as write:
        read.backup(write)
