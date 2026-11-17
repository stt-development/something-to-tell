"""Initial source-target aliases are authored once, never inferred by export."""

from collections.abc import Iterable

from ..schemas.engine_tags import (
    ENGINE_TAG_AUTHORING_TARGETS,
    EngineTagTargetAliasV1,
    normalize_engine_tag_key,
)


def initial_target_aliases(
    key: str, existing: Iterable[EngineTagTargetAliasV1],
) -> list[EngineTagTargetAliasV1]:
    """Allocate deterministic, unique Ink/Yarn identifiers for a new definition."""

    aliases = list(existing)
    base = normalize_engine_tag_key(key).replace(".", "_")
    result = []
    for target in ENGINE_TAG_AUTHORING_TARGETS:
        used = {item.external_identifier.casefold() for item in aliases if item.target == target}
        identifier, suffix = base, 2
        while identifier.casefold() in used:
            identifier, suffix = f"{base}_{suffix}", suffix + 1
        result.append(EngineTagTargetAliasV1(target=target, external_identifier=identifier))
    return result
