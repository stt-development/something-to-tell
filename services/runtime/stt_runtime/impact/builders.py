"""Shared constructors for deterministic domain dependency adapters."""

from __future__ import annotations

from typing import Any

from ..schemas.impact_analysis import (
    ImpactDependency,
    ImpactDomain,
    ImpactEvidenceRef,
    ImpactPropagation,
    ImpactResourceRef,
)


def resource_ref(
    owner_type: str,
    owner_id: str,
    *,
    context: ImpactResourceRef | None = None,
) -> ImpactResourceRef:
    """Create the Canon-compatible stable owner shape used by every adapter."""

    return ImpactResourceRef(
        owner_type=owner_type,
        owner_id=owner_id,
        context_type=context.owner_type if context is not None else None,
        context_id=context.owner_id if context is not None else None,
    )


def evidence_ref(
    owner: ImpactResourceRef,
    *,
    field_path: str | None,
    message_key: str,
    parameters: dict[str, Any] | None = None,
    excerpt: str | None = None,
) -> ImpactEvidenceRef:
    return ImpactEvidenceRef(
        owner=owner,
        field_path=field_path,
        message_key=message_key,
        message_parameters=parameters or {},
        excerpt=excerpt,
    )


def dependency(
    source: ImpactResourceRef,
    target: ImpactResourceRef,
    *,
    domain: ImpactDomain,
    kind: str,
    propagation: ImpactPropagation,
    message_key: str,
    parameters: dict[str, Any] | None = None,
    evidence: ImpactEvidenceRef,
) -> ImpactDependency:
    return ImpactDependency(
        source=source,
        target=target,
        domain=domain,
        kind=kind,
        propagation=propagation,
        message_key=message_key,
        message_parameters=parameters or {},
        evidence=(evidence,),
    )


def unique_refs(resources: list[ImpactResourceRef]) -> tuple[ImpactResourceRef, ...]:
    keyed = {resource.stable_key(): resource for resource in resources}
    return tuple(keyed[key] for key in sorted(keyed))
