"""Immutable storage-neutral index over validated Impact dependencies."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Iterable, Mapping

from ..schemas.impact_analysis import ImpactDependency, ImpactDomain, ImpactResourceRef

ResourceKey = tuple[str, str, str, str]


@dataclass(frozen=True)
class ImpactDependencyIndex:
    """Deterministic adjacency index built from one ProjectDocument checksum."""

    project_id: str
    source_checksum: str
    resources: tuple[ImpactResourceRef, ...]
    dependencies: tuple[ImpactDependency, ...]
    _outgoing: Mapping[ResourceKey, tuple[ImpactDependency, ...]] = field(
        repr=False,
        compare=False,
    )
    _incoming: Mapping[ResourceKey, tuple[ImpactDependency, ...]] = field(
        repr=False,
        compare=False,
    )

    @classmethod
    def build(
        cls,
        *,
        project_id: str,
        source_checksum: str,
        resources: Iterable[ImpactResourceRef],
        dependencies: Iterable[ImpactDependency],
    ) -> "ImpactDependencyIndex":
        """Normalize caller-owned collections without retaining mutable containers."""

        dependency_by_key: dict[tuple[str, ...], ImpactDependency] = {}
        for dependency in sorted(dependencies, key=_dependency_selection_key):
            dependency_by_key.setdefault(dependency.stable_key(), dependency)
        ordered_dependencies = tuple(
            sorted(dependency_by_key.values(), key=ImpactDependency.stable_key)
        )

        resource_by_key = {resource.stable_key(): resource for resource in resources}
        for dependency in ordered_dependencies:
            resource_by_key[dependency.source.stable_key()] = dependency.source
            resource_by_key[dependency.target.stable_key()] = dependency.target
        ordered_resources = tuple(resource_by_key[key] for key in sorted(resource_by_key))

        outgoing: dict[ResourceKey, list[ImpactDependency]] = {}
        incoming: dict[ResourceKey, list[ImpactDependency]] = {}
        for dependency in ordered_dependencies:
            outgoing.setdefault(dependency.source.stable_key(), []).append(dependency)
            incoming.setdefault(dependency.target.stable_key(), []).append(dependency)

        return cls(
            project_id=project_id,
            source_checksum=source_checksum,
            resources=ordered_resources,
            dependencies=ordered_dependencies,
            _outgoing=MappingProxyType(
                {key: tuple(values) for key, values in outgoing.items()}
            ),
            _incoming=MappingProxyType(
                {key: tuple(values) for key, values in incoming.items()}
            ),
        )

    def contains(self, resource: ImpactResourceRef) -> bool:
        return any(item.stable_key() == resource.stable_key() for item in self.resources)

    def outgoing(
        self,
        resource: ImpactResourceRef,
        *,
        domains: frozenset[ImpactDomain] | None = None,
    ) -> tuple[ImpactDependency, ...]:
        return _filter_domains(self._outgoing.get(resource.stable_key(), ()), domains)

    def incoming(
        self,
        resource: ImpactResourceRef,
        *,
        domains: frozenset[ImpactDomain] | None = None,
    ) -> tuple[ImpactDependency, ...]:
        return _filter_domains(self._incoming.get(resource.stable_key(), ()), domains)


def _filter_domains(
    dependencies: tuple[ImpactDependency, ...],
    domains: frozenset[ImpactDomain] | None,
) -> tuple[ImpactDependency, ...]:
    if domains is None:
        return dependencies
    return tuple(item for item in dependencies if item.domain in domains)


def _dependency_selection_key(dependency: ImpactDependency) -> tuple[str, ...]:
    """Choose one deterministic representative when adapters emit an exact duplicate."""

    return (
        *dependency.stable_key(),
        dependency.message_key,
        *(item.message_key for item in dependency.evidence),
    )
