import pytest

from services.runtime.stt_runtime.canon.registry import (
    CanonRuleRegistry,
    CanonRuleRegistryError,
)
from services.runtime.stt_runtime.project_format.manifest import CanonCheckSettings


def _descriptor(
    rule_id: str,
    *,
    severity: str = "warning",
    supported: list[str] | None = None,
) -> dict[str, object]:
    return {
        "descriptor_version": 1,
        "id": rule_id,
        "version": 1,
        "category": "continuity",
        "default_severity": severity,
        "input_domains": ["flow"],
        "supported_severity_overrides": supported or ["warning", "critical"],
    }


def test_registry_orders_rules_and_applies_known_settings() -> None:
    registry = CanonRuleRegistry([
        _descriptor("quest.required-outcome"),
        _descriptor("flow.unresolved-condition"),
        _descriptor("dialogue.dead-end"),
    ])
    settings = CanonCheckSettings(
        enabled_rules={"dialogue.dead-end": False},
        severity_overrides={"flow.unresolved-condition": "critical"},
    )

    resolved = registry.resolve(settings)

    assert [item.id for item in registry.descriptors] == [
        "dialogue.dead-end",
        "flow.unresolved-condition",
        "quest.required-outcome",
    ]
    assert [(item.descriptor.id, item.severity) for item in resolved] == [
        ("flow.unresolved-condition", "critical"),
        ("quest.required-outcome", "warning"),
    ]


def test_registry_rejects_duplicate_ids_and_invalid_versions() -> None:
    with pytest.raises(CanonRuleRegistryError) as duplicate:
        CanonRuleRegistry([_descriptor("flow.rule"), _descriptor("flow.rule")])
    assert duplicate.value.code == "canon_rule_duplicate"
    assert duplicate.value.rule_id == "flow.rule"

    invalid = _descriptor("flow.rule")
    invalid["version"] = 0
    with pytest.raises(CanonRuleRegistryError) as version:
        CanonRuleRegistry([invalid])
    assert version.value.code == "canon_rule_invalid"


def test_registry_rejects_unknown_rule_settings() -> None:
    registry = CanonRuleRegistry([_descriptor("flow.rule")])

    with pytest.raises(CanonRuleRegistryError) as caught:
        registry.resolve(CanonCheckSettings(enabled_rules={"unknown.rule": False}))

    assert caught.value.code == "canon_rule_unknown"
    assert caught.value.rule_id == "unknown.rule"


def test_registry_rejects_unsupported_severity_override() -> None:
    registry = CanonRuleRegistry([
        _descriptor("flow.rule", supported=["warning", "critical"])
    ])

    with pytest.raises(CanonRuleRegistryError) as caught:
        registry.resolve(CanonCheckSettings(severity_overrides={"flow.rule": "info"}))

    assert caught.value.code == "canon_rule_severity_unsupported"
    assert caught.value.rule_id == "flow.rule"
