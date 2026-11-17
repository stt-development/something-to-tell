"""Explicit offline operator reset; not a backup creator or runtime endpoint."""

import argparse
import json
import os

from sqlalchemy import create_engine, make_url

from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.storage_restore import reset_restored_generations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-database", required=True)
    parser.add_argument("--confirm-isolated-restore", action="store_true")
    args = parser.parse_args()
    engine = None
    try:
        url = make_url(os.environ["STT_RESTORE_DATABASE_URL"])
        if url.drivername != "postgresql+psycopg":
            raise ValueError("unsupported_driver")
        if "sslmode" not in url.query:
            url = url.update_query_dict({"sslmode": "verify-full"})
        engine = create_engine(url, connect_args={"connect_timeout": 5})
        result = reset_restored_generations(engine, expected_database=args.expected_database,
                                           confirmed=args.confirm_isolated_restore)
        print(json.dumps({"status": "ok", **result}))
        return 0
    except Exception as error:
        # Driver/validation messages can contain credentials or author content.
        code = error.code if isinstance(error, ProjectSessionError) else "restore_failed"
        print(json.dumps({"status": "failed", "code": code}))
        return 1
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
