"""Storage-independent validation and ordering for canon rule descriptors."""

from collections.abc import Iterable
from typing import Any

from pydantic import ValidationError

from ..project_format.manifest import CanonCheckSettings
from ..schemas.canon_check import CanonRuleDescriptor, ResolvedCanonRule


class CanonRuleRegistryError(ValueError):
    """Stable configuration failure consumed by the future run coordinator."""

    def __init__(self, code: str, *, rule_id: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.rule_id = rule_id


class CanonRuleRegistry:
    """Owns deterministic descriptor validation for executable canon rules."""

    def __init__(self, descriptors: Iterable[CanonRuleDescriptor | dict[str, Any]]) -> None:
        parsed: list[CanonRuleDescriptor] = []
        try:
            parsed = [CanonRuleDescriptor.model_validate(item) for item in descriptors]
        except ValidationError as error:
            raise CanonRuleRegistryError("canon_rule_invalid") from error
        duplicate = _first_duplicate(descriptor.id for descriptor in parsed)
        if duplicate is not None:
            raise CanonRuleRegistryError("canon_rule_duplicate", rule_id=duplicate)
        self._descriptors = tuple(sorted(parsed, key=lambda item: (item.id, item.version)))
        self._by_id = {descriptor.id: descriptor for descriptor in self._descriptors}

    @property
    def descriptors(self) -> tuple[CanonRuleDescriptor, ...]:
        return self._descriptors

    def resolve(self, settings: CanonCheckSettings) -> tuple[ResolvedCanonRule, ...]:
        """Apply only known project rule settings in stable descriptor order."""

        configured_ids = set(settings.enabled_rules) | set(settings.severity_overrides)
        unknown = sorted(configured_ids - self._by_id.keys())
        if unknown:
            raise CanonRuleRegistryError("canon_rule_unknown", rule_id=unknown[0])

        resolved: list[ResolvedCanonRule] = []
        for descriptor in self._descriptors:
            if settings.enabled_rules.get(descriptor.id, True) is False:
                continue
            severity = settings.severity_overrides.get(
                descriptor.id,
                descriptor.default_severity,
            )
            if severity not in descriptor.supported_severity_overrides:
                raise CanonRuleRegistryError(
                    "canon_rule_severity_unsupported",
                    rule_id=descriptor.id,
                )
            resolved.append(ResolvedCanonRule(descriptor=descriptor, severity=severity))
        return tuple(resolved)


def _first_duplicate(values: Iterable[str]) -> str | None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            return value
        seen.add(value)
    return None
