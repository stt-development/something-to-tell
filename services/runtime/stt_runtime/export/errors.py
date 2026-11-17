"""Stable localized failures for export planning and artifact installation."""

from __future__ import annotations

from typing import Any

from ..schemas.export import ExportErrorCode


class ExportOperationError(RuntimeError):
    """Cross-layer error that carries no exception text or machine secrets."""

    def __init__(self, code: ExportErrorCode, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.message_key = f"export.error.{code}"
        self.parameters = parameters
