from typing import Any


class ProjectSessionError(ValueError):
    """Stable localization-ready project lifecycle failure."""

    def __init__(self, code: str, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters
