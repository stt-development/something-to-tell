"""R2b3: attribute remaining known batch groups in an owned migration only."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from unittest.mock import patch

from services.runtime.scripts import profile_storage_migration as migration
from services.runtime.scripts.benchmark_storage import disposable_database
from services.runtime.stt_runtime.repositories import sqlite as repositories


class MigrationBatchProfile(migration.MigrationProfile):
    # Concrete source-defined names only; no authored entity data becomes labels.
    TARGETS = migration.MigrationProfile.TARGETS + tuple(
        (owner, "add_many", "batch_" + owner.__name__.removeprefix("SqlAlchemy").removesuffix("Repository"))
        for owner in sorted(repositories._BATCH_ADD_REPOSITORIES, key=lambda owner: owner.__name__)
    ) + ((repositories.SqlAlchemyAgentMemoryRepository, "add", "memory_add"),)


def profile_batches(size, url, *, parent=None):
    # This override is scoped to this single worker operation, not a runtime flag.
    with patch.object(migration, "MigrationProfile", MigrationBatchProfile):
        report = migration.profile_migration(size, url, instrumented=True, parent=parent)
    report["diagnostic_kind"] = "repository_batches"
    report["probe_sha256"] = sha256(Path(__file__).read_bytes() + Path(migration.__file__).read_bytes()).hexdigest()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=("small", "1000"), required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = dict(report_version=1, status="failed", cleanup="not_acquired", database_cleanup="unavailable")
    try:
        with disposable_database() as url:
            report = profile_batches(args.size, url)
        report["database_cleanup"] = "released"
    except Exception as error:
        report.update(status="failed", error_code=migration._error_code(error), error_type=type(error).__name__)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cleanup": report["cleanup"], "report": str(args.report)}))
    return 0 if report["status"] == "ok" and report["cleanup"] == "released" else 1


if __name__ == "__main__":
    raise SystemExit(main())
