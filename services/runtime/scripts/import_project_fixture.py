"""Import a source fixture for disposable browser and manual validation runs."""

import argparse
from pathlib import Path

from services.runtime.stt_runtime.project_fixture import import_project_fixture


def main() -> None:
    """Validate the fixture and create its generated .narrative workspace."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    import_project_fixture(arguments.fixture, arguments.destination)


if __name__ == "__main__":
    main()
