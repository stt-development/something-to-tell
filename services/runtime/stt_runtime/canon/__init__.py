"""Deterministic canon-check projection, registry, and rule boundaries."""

from .engine import (
    CANON_RULE_PACK_VERSION,
    CanonRuleEngine,
    CanonRuleEngineError,
    CanonRulePack,
    initial_canon_rule_pack,
)
from .projection import CanonFactProjector
from .reconciliation import (
    CanonIssueReconciler,
    CanonIssueReconciliationError,
    CanonIssueReconciliationResult,
)
from .registry import CanonRuleRegistry, CanonRuleRegistryError

__all__ = [
    "CANON_RULE_PACK_VERSION",
    "CanonFactProjector",
    "CanonIssueReconciler",
    "CanonIssueReconciliationError",
    "CanonIssueReconciliationResult",
    "CanonRuleEngine",
    "CanonRuleEngineError",
    "CanonRulePack",
    "CanonRuleRegistry",
    "CanonRuleRegistryError",
    "initial_canon_rule_pack",
]
