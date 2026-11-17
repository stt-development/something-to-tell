"""Disposable supervisor fixture: abrupt exit must close its private child pipe."""
import json
import os
from pathlib import Path
import sys

from services.runtime.tests.desktop_lifecycle_support import add_draft, post, running_child


def main():
    directory = Path(sys.argv[1])
    with running_child(directory) as (_, port, token):
        project = post(port, token, "/api/project-sessions/create", {
            "path": str(directory / "Parent death.narrative"), "name": "Parent death"}, expected=201)
        node = add_draft(port, token, project)
        # No capability is sent to the test parent. This process owns the only
        # writer of runtime stdin, so os._exit genuinely tests parent death.
        print(json.dumps({"port": port, "node_id": node["id"]}), flush=True)
        if sys.stdin.readline() != "exit\n":
            raise RuntimeError("invalid fixture command")
        os._exit(17)


if __name__ == "__main__":
    main()
