"""Testable P9-001 instrumentation; attach only during disposable benchmark work."""

import gc
from contextlib import contextmanager, nullcontext
import platform
import resource
import signal
import time
import tracemalloc

from sqlalchemy import Engine, event

ANALYSIS_MAX_SECONDS = 180
ANALYSIS_MAX_ALLOCATION_BYTES = 2 * 1024 ** 3


class OperationBudgetExceeded(RuntimeError):
    """A censored measurement, never a successful latency sample."""


def _check_budget(started, deadline_seconds, allocation_limit_bytes):
    if time.perf_counter() - started >= deadline_seconds:
        raise OperationBudgetExceeded("wall_time")
    if tracemalloc.get_traced_memory()[1] >= allocation_limit_bytes:
        raise OperationBudgetExceeded("python_allocation")


@contextmanager
def analysis_budget():
    """POSIX worker-only read guard; disable before unwinding/cleaning up.

    Do not interrupt mutating application commands with this timer: their failure
    recovery may itself be expensive. This bounds only read-only Canon capture.
    """
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise RuntimeError("scale_timer_already_active")
    previous = signal.getsignal(signal.SIGALRM)
    started = time.perf_counter()

    def check(signum, frame):
        try:
            _check_budget(started, ANALYSIS_MAX_SECONDS, ANALYSIS_MAX_ALLOCATION_BYTES)
        except OperationBudgetExceeded:
            signal.setitimer(signal.ITIMER_REAL, 0)
            raise

    signal.signal(signal.SIGALRM, check)
    signal.setitimer(signal.ITIMER_REAL, 0.1, 0.1)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class OperationMetrics:
    """Count SQLAlchemy cursor calls, not rows or raw database-backup operations."""

    def __init__(self):
        self.calls = 0
        self.parameter_sets = 0
        self.sql_seconds = 0.0
        self.reads = self.writes = self.ddl = 0

    def _before(self, connection, cursor, statement, parameters, context, executemany):
        context._scale_started = time.perf_counter()
        self.calls += 1
        self.parameter_sets += len(parameters) if executemany else 1
        command = statement.lstrip().split(None, 1)[0].upper()
        if command in {"SELECT", "PRAGMA", "SHOW"}:
            self.reads += 1
        elif command in {"INSERT", "UPDATE", "DELETE"}:
            self.writes += 1
        elif command in {"CREATE", "ALTER", "DROP"}:
            self.ddl += 1

    def _after(self, connection, cursor, statement, parameters, context, executemany):
        self.sql_seconds += time.perf_counter() - context._scale_started

    def measure(self, name, operation, *, bounded_analysis=False):
        """Exceptions propagate; listeners/tracing must never outlive an operation."""
        gc.collect()
        if tracemalloc.is_tracing():
            raise RuntimeError("scale_tracing_already_active")
        tracemalloc.start()
        event.listen(Engine, "before_cursor_execute", self._before)
        event.listen(Engine, "after_cursor_execute", self._after)
        start = time.perf_counter()
        try:
            with analysis_budget() if bounded_analysis else nullcontext():
                result = operation()
        finally:
            elapsed = time.perf_counter() - start
            retained, peak = tracemalloc.get_traced_memory()
            event.remove(Engine, "before_cursor_execute", self._before)
            event.remove(Engine, "after_cursor_execute", self._after)
            tracemalloc.stop()
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            self.last = {
                "operation": name, "wall_seconds": round(elapsed, 6), "cursor_calls": self.calls,
                "parameter_sets": self.parameter_sets, "read_calls": self.reads, "write_calls": self.writes,
                "ddl_calls": self.ddl, "sql_seconds": round(self.sql_seconds, 6),
                "python_allocation_peak_bytes": peak, "python_retained_bytes": retained,
                "process_rss_high_water_bytes": rss if platform.system() == "Darwin" else rss * 1024,
            }
        return result, self.last
