"""Own one existing benchmark-style disposable database until the parent closes stdin."""

import json
import signal
import sys

from services.runtime.scripts.benchmark_storage import disposable_database


def serve(input_stream, output_stream):
    """Return only the generated database name; never emit connection credentials."""
    with disposable_database() as url:
        print(json.dumps({"database": url.database}), file=output_stream, flush=True)
        input_stream.readline()


def main():
    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    serve(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
