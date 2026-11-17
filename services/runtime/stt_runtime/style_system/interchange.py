"""Explicit deterministic StyleProfile JSON import and export."""

import json
import os
from pathlib import Path
from datetime import datetime

from pydantic import ValidationError

from ..schemas.style_system import StyleProfileFileV1, StyleProfileV1


class StyleInterchangeError(ValueError):
    """Stable, redacted failure for explicit profile file operations."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


def export_style_profile(styles_directory: Path, profile: StyleProfileV1) -> Path:
    """Atomically materialize one profile without project or provider identity."""

    styles_directory.mkdir(parents=True, exist_ok=True)
    destination = styles_directory / f"{profile.id}.style.json"
    envelope = StyleProfileFileV1(
        id=profile.id,
        name=profile.name,
        description=profile.description,
        guidance=profile.guidance,
        traits=profile.traits,
        positive_examples=profile.positive_examples,
    )
    temporary = destination.with_name(f".{destination.name}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            stream.write(
                json.dumps(
                    envelope.model_dump(mode="json"),
                    ensure_ascii=True,
                    indent=2,
                    sort_keys=True,
                )
                + "\n"
            )
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(destination)
        directory_fd = os.open(styles_directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return destination
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise StyleInterchangeError("style_profile_export_failed") from error


def import_style_profile(
    path: Path,
    *,
    project_id: str,
    existing_profile_ids: set[str],
    replace_existing: bool,
    now: datetime,
) -> StyleProfileV1:
    """Validate one chosen file; opening a project never calls this function."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        envelope = StyleProfileFileV1.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        raise StyleInterchangeError("style_profile_import_invalid") from error
    if envelope.id in existing_profile_ids and not replace_existing:
        raise StyleInterchangeError(
            "style_profile_import_collision", profile_id=envelope.id
        )
    return StyleProfileV1(
        style_profile_version=1,
        id=envelope.id,
        project_id=project_id,
        name=envelope.name,
        description=envelope.description,
        guidance=envelope.guidance,
        traits=envelope.traits,
        positive_examples=envelope.positive_examples,
        created_at=now,
        updated_at=now,
    )
