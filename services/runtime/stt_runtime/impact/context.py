"""Bounded provider context projected from one immutable Impact snapshot."""

from __future__ import annotations

from collections import defaultdict
import json
from typing import Any, Iterable

from pydantic import BaseModel, ValidationError

from ..agent_memory.context import resolve_agent_memory_provider_data
from ..agent_memory.resolver import AgentMemoryResolutionError
from ..schemas.agent_memory import (
    AgentMemoryScopeV1,
    ApprovedAgentMemoryV1,
    NodeMemoryScopeV1,
    ProjectMemoryScopeV1,
    SceneMemoryScopeV1,
    StoryFlowMemoryScopeV1,
)
from ..schemas.canon_check import (
    CanonEvidenceRef,
    CanonOwnerRef,
    parse_canon_issue_metadata,
)
from ..schemas.dialogue import DialogueChoiceElement
from ..schemas.impact_analysis import (
    ImpactAnalysisInput,
    ImpactAnalysisRun,
    ImpactDependency,
    ImpactFinding,
    PatchImpactScenario,
    SelectionImpactScenario,
)
from ..schemas.impact_resolution import (
    ImpactResolutionContextPackage,
    ImpactResolutionContextResource,
    ImpactResolutionGlossaryEntry,
    ImpactResolutionRequest,
)
from ..schemas.project_document import ProjectDocument

_DOMAINS = (
    "graph", "composition", "flow", "dialogue", "quest", "temporal", "playback", "canon"
)
_GLOSSARY_NODE_TYPES = {"character", "location", "item", "faction"}
_SECRET_KEYS = {
    "access_token", "api_key", "credential", "credentials", "password",
    "private_key", "refresh_token", "secret", "token",
}
_SECRET_SUFFIXES = (
    "_api_key", "_credentials", "_password", "_private_key", "_secret", "_token"
)
_PRESENTATION_KEYS = {
    "canvas_layout", "composition_frame", "height", "isframe", "position", "width"
}
_PRIVATE_RUNTIME_KEYS = {
    "checkpoint", "connection_profile_id", "history", "local_path", "lock",
    "project_path", "storage", "storage_profile",
}
_RECORD_COLLECTIONS = {
    "node": "nodes",
    "edge": "edges",
    "placement": "placements",
    "issue": "issues",
    "flow": "story_flows",
    "flow_member": "story_flow_nodes",
    "flow_transition": "flow_transitions",
    "scene_boundary": "scene_flow_boundaries",
    "flow_invocation": "flow_invocations",
    "flow_exit": "flow_exits",
    "flow_exit_binding": "flow_exit_bindings",
    "initial_state": "flow_initial_states",
    "effect": "narrative_effects",
    "effect_binding": "narrative_effect_bindings",
}


class ImpactContextBuilderError(ValueError):
    """Typed failure when fixed selected findings cannot fit the requested bound."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class ImpactResolutionContextBuilder:
    """Project only selected paths and their exact authored evidence neighborhood."""

    def build(
        self,
        captured: ImpactAnalysisInput,
        run: ImpactAnalysisRun,
        request: ImpactResolutionRequest,
    ) -> ImpactResolutionContextPackage:
        if run.status != "completed" or run.id != request.impact_run_id:
            raise ImpactContextBuilderError(
                "impact_resolution_finding_invalid", reason="impact_run_not_completed"
            )
        if captured.source_checksum != request.source_checksum:
            raise ImpactContextBuilderError("impact_resolution_run_stale")
        approved_memory = self._approved_memory(captured)

        finding_by_id = {finding.id: finding for finding in run.findings}
        try:
            findings = tuple(finding_by_id[finding_id] for finding_id in request.finding_ids)
        except KeyError as error:
            raise ImpactContextBuilderError(
                "impact_resolution_finding_invalid", finding_id=str(error.args[0])
            ) from error

        domains: dict[tuple[str, str, str, str], set[str]] = defaultdict(set)
        refs: dict[tuple[str, str, str, str], CanonOwnerRef] = {}
        evidence: dict[tuple[str, str, str, str], dict[tuple[str, ...], CanonEvidenceRef]] = (
            defaultdict(dict)
        )
        dependencies: dict[
            tuple[str, str, str, str], dict[tuple[str, ...], ImpactDependency]
        ] = defaultdict(dict)

        def add_ref(resource: CanonOwnerRef, domain: str) -> None:
            refs.setdefault(resource.stable_key(), resource)
            domains[resource.stable_key()].add(domain)

        for finding in findings:
            add_ref(finding.target, finding.domain)
            for seed in finding.seeds:
                add_ref(seed.resource, finding.domain)
            for path in finding.paths:
                for resource in path.resources:
                    add_ref(resource, finding.domain)
                for dependency in path.dependencies:
                    for endpoint in (dependency.source, dependency.target):
                        add_ref(endpoint, dependency.domain)
                        dependencies[endpoint.stable_key()][dependency.stable_key()] = dependency
                    for item in dependency.evidence:
                        add_ref(item.owner, dependency.domain)
                        evidence[item.owner.stable_key()][item.stable_key()] = item

        self._add_related_canon_issues(
            captured.document,
            tuple(refs),
            add_ref,
            evidence,
        )
        if isinstance(captured.request.scenario, PatchImpactScenario):
            scenario = CanonOwnerRef(owner_type="impact_scenario", owner_id=run.id)
            add_ref(scenario, "graph")

        ordered_refs = sorted(
            refs.values(),
            key=lambda item: (
                min(_DOMAINS.index(domain) for domain in domains[item.stable_key()]),
                item.stable_key(),
            ),
        )
        resources = [
            self._resource(
                captured.document,
                resource,
                self._primary_domain(domains[resource.stable_key()]),
                tuple(evidence[resource.stable_key()].values()),
                tuple(dependencies[resource.stable_key()].values()),
                captured.request.scenario if resource.owner_type == "impact_scenario" else None,
            )
            for resource in ordered_refs
        ]

        max_resources = request.limits.max_context_resources
        included_resources = resources[:max_resources]
        omitted = resources[max_resources:]
        glossary = self._glossary(captured.document, included_resources)
        available_glossary = max(0, max_resources - len(included_resources))
        included_glossary = glossary[:available_glossary]
        omitted_glossary = glossary[available_glossary:]
        omitted_count = len(omitted) + len(omitted_glossary)
        omitted_domains = {
            item.domain for item in omitted
        } | ({"graph"} if omitted_glossary else set())

        while True:
            package = self._package(
                captured,
                request,
                findings,
                included_resources,
                included_glossary,
                omitted_count,
                omitted_domains,
                approved_memory,
            )
            if self._characters(package) <= request.limits.max_context_characters:
                return ImpactResolutionContextPackage.model_validate(package)
            if included_glossary:
                included_glossary.pop()
                omitted_count += 1
                omitted_domains.add("graph")
                continue
            if included_resources:
                removed = included_resources.pop()
                omitted_count += 1
                omitted_domains.add(removed.domain)
                continue
            raise ImpactContextBuilderError(
                "impact_resolution_limit_invalid",
                field="max_context_characters",
                minimum=self._characters(package),
            )

    @staticmethod
    def _approved_memory(captured: ImpactAnalysisInput) -> ApprovedAgentMemoryV1:
        """Resolve Impact-only assumptions from the original deterministic seeds."""

        project_scope = ProjectMemoryScopeV1()
        target_scope: AgentMemoryScopeV1 = project_scope
        context_scope: ProjectMemoryScopeV1 | SceneMemoryScopeV1 | StoryFlowMemoryScopeV1 = (
            project_scope
        )
        scenario = captured.request.scenario
        if isinstance(scenario, SelectionImpactScenario) and len(scenario.seeds) == 1:
            resource = scenario.seeds[0].resource
            if resource.owner_type == "story_flow":
                target_scope = StoryFlowMemoryScopeV1(flow_id=resource.owner_id)
                context_scope = target_scope
            elif resource.owner_type == "node":
                target_scope = NodeMemoryScopeV1(node_id=resource.owner_id)
            if resource.context_type == "scene" and resource.context_id:
                context_scope = SceneMemoryScopeV1(scene_node_id=resource.context_id)
            elif resource.context_type == "flow" and resource.context_id:
                context_scope = StoryFlowMemoryScopeV1(flow_id=resource.context_id)
        try:
            return resolve_agent_memory_provider_data(
                captured.document,
                history_revision=captured.history_revision,
                agent_id="impact_resolver",
                scope=target_scope,
                context_scope=context_scope,
            ).approved_memory
        except AgentMemoryResolutionError as error:
            raise ImpactContextBuilderError(error.code, **error.parameters) from error

    @staticmethod
    def _add_related_canon_issues(
        document: ProjectDocument,
        selected_keys: tuple[tuple[str, str, str, str], ...],
        add_ref: Any,
        evidence: dict[
            tuple[str, str, str, str], dict[tuple[str, ...], CanonEvidenceRef]
        ],
    ) -> None:
        selected = set(selected_keys)
        for issue in document.issues:
            try:
                metadata = parse_canon_issue_metadata(issue.metadata)
            except ValidationError:
                metadata = None
            if metadata is None or issue.status not in {"open", "review"}:
                continue
            owners = {item.stable_key() for item in metadata.targets}
            if metadata.scope is not None:
                owners.add(metadata.scope.stable_key())
            if not selected.intersection(owners):
                continue
            issue_ref = CanonOwnerRef(owner_type="issue", owner_id=issue.id)
            add_ref(issue_ref, "canon")
            for item in metadata.evidence:
                add_ref(item.owner, "canon")
                evidence[item.owner.stable_key()][item.stable_key()] = item

    def _resource(
        self,
        document: ProjectDocument,
        resource: CanonOwnerRef,
        domain: str,
        evidence: tuple[CanonEvidenceRef, ...],
        dependencies: tuple[ImpactDependency, ...],
        scenario: object | None,
    ) -> ImpactResolutionContextResource:
        fields, title = self._resolve(document, resource, scenario)
        if dependencies:
            fields["path_dependencies"] = [
                {
                    "domain": item.domain,
                    "kind": item.kind,
                    "propagation": item.propagation,
                    "parameters": self._safe_value(item.message_parameters),
                }
                for item in sorted(dependencies, key=ImpactDependency.stable_key)
            ]
        return ImpactResolutionContextResource(
            resource=resource,
            domain=domain,
            title=title,
            authored_fields=self._bounded_fields(fields),
            evidence=tuple(sorted(evidence, key=CanonEvidenceRef.stable_key)),
        )

    def _resolve(
        self,
        document: ProjectDocument,
        resource: CanonOwnerRef,
        scenario: object | None,
    ) -> tuple[dict[str, Any], str | None]:
        if resource.owner_type == "impact_scenario" and scenario is not None:
            payload = scenario.model_dump(mode="json") if isinstance(scenario, BaseModel) else {}
            return {"scenario": self._safe_value(payload)}, "Analyzed patch scenario"

        if resource.owner_type == "playback_definition":
            flow = next(
                (item for item in document.story_flows if item.id == resource.owner_id),
                None,
            )
            if flow is not None:
                # Playback definitions are derived, so expose only their exact authored inputs.
                members = [
                    item.node_id
                    for item in document.story_flow_nodes
                    if item.flow_id == flow.id
                ]
                transitions = [
                    item.id
                    for item in document.flow_transitions
                    if item.flow_id == flow.id
                ]
                fields = {
                    "flow_id": flow.id,
                    "flow_name": flow.name,
                    "entry_node_id": flow.entry_node_id,
                    "member_node_ids": sorted(members),
                    "transition_ids": sorted(transitions),
                }
                return fields, flow.name

        collection_name = _RECORD_COLLECTIONS.get(resource.owner_type)
        if collection_name is not None:
            record = next(
                (item for item in getattr(document, collection_name) if item.id == resource.owner_id),
                None,
            )
            if record is not None:
                fields = self._record_fields(record)
                if resource.owner_type == "issue":
                    fields = self._issue_fields(record)
                return fields, self._title(fields, resource.owner_id)

        nested = self._nested_fields(document, resource)
        if nested is not None:
            return nested, self._title(nested, resource.owner_id)
        return {"derived_resource": True}, resource.owner_id

    def _nested_fields(
        self,
        document: ProjectDocument,
        resource: CanonOwnerRef,
    ) -> dict[str, Any] | None:
        if resource.owner_type == "dialogue_participant":
            return {
                "dialogue_node_id": resource.context_id,
                "participant_node_id": resource.owner_id,
            }
        for owned in document.dialogues:
            for element in owned.document.elements:
                if resource.owner_type == "dialogue_element" and element.id == resource.owner_id:
                    return self._safe_value(element.model_dump(mode="json"))
                if isinstance(element, DialogueChoiceElement):
                    for option in element.options:
                        if resource.owner_type == "dialogue_option" and option.id == resource.owner_id:
                            return {
                                "dialogue_node_id": owned.node_id,
                                "choice_element_id": element.id,
                                **self._safe_value(option.model_dump(mode="json")),
                            }
        for owned in document.quests:
            if resource.owner_type in {"quest_requirement", "quest_reward", "quest_giver"}:
                return {
                    "quest_node_id": owned.node_id,
                    "node_id": resource.owner_id,
                    "role": resource.owner_type.removeprefix("quest_"),
                }
            for stage in owned.document.stages:
                if resource.owner_type == "quest_stage" and stage.id == resource.owner_id:
                    return {
                        "quest_node_id": owned.node_id,
                        **self._safe_value(stage.model_dump(mode="json")),
                    }
                for branch in stage.branches:
                    if resource.owner_type == "quest_branch" and branch.id == resource.owner_id:
                        return {
                            "quest_node_id": owned.node_id,
                            "stage_id": stage.id,
                            **self._safe_value(branch.model_dump(mode="json")),
                        }
        if resource.owner_type in {"flow_entry", "flow_terminal"}:
            return {"flow_id": resource.context_id, "node_id": resource.owner_id}
        return None

    def _record_fields(self, record: BaseModel) -> dict[str, Any]:
        payload = record.model_dump(
            mode="json", exclude={"created_at", "updated_at", "project_id"}
        )
        payload.pop("id", None)
        metadata = payload.pop("metadata", None)
        if isinstance(metadata, dict):
            safe_metadata = self._safe_value(metadata)
            if safe_metadata:
                payload["metadata"] = safe_metadata
        return self._safe_value(payload)

    def _issue_fields(self, record: BaseModel) -> dict[str, Any]:
        payload = self._record_fields(record)
        try:
            metadata = parse_canon_issue_metadata(record.metadata)
        except ValidationError:
            metadata = None
        if metadata is None:
            return payload
        payload["canon"] = {
            "rule_id": metadata.rule_id,
            "category": metadata.category,
            "message_key": metadata.message_key,
            "message_parameters": self._safe_value(metadata.message_parameters),
            "recommendation_key": metadata.recommendation_key,
            "recommendation_parameters": self._safe_value(
                metadata.recommendation_parameters
            ),
            "targets": [item.model_dump(mode="json") for item in metadata.targets],
        }
        payload.pop("metadata", None)
        return payload

    def _glossary(
        self,
        document: ProjectDocument,
        resources: list[ImpactResolutionContextResource],
    ) -> list[ImpactResolutionGlossaryEntry]:
        nodes = {node.id: node for node in document.nodes}
        referenced_ids = {
            resource.resource.owner_id
            for resource in resources
            if resource.resource.owner_type == "node"
        }
        for resource in resources:
            referenced_ids.update(self._referenced_node_ids(resource.authored_fields, set(nodes)))
        return [
            ImpactResolutionGlossaryEntry(
                resource=CanonOwnerRef(owner_type="node", owner_id=node_id),
                label=nodes[node_id].title,
                kind=nodes[node_id].type,
            )
            for node_id in sorted(referenced_ids)
            if nodes[node_id].type.lower() in _GLOSSARY_NODE_TYPES
        ]

    @classmethod
    def _referenced_node_ids(cls, value: Any, node_ids: set[str]) -> set[str]:
        if isinstance(value, dict):
            return set().union(*(cls._referenced_node_ids(item, node_ids) for item in value.values()))
        if isinstance(value, list):
            return set().union(*(cls._referenced_node_ids(item, node_ids) for item in value))
        return {value} if isinstance(value, str) and value in node_ids else set()

    @classmethod
    def _safe_value(cls, value: Any) -> Any:
        if isinstance(value, dict):
            safe: dict[str, Any] = {}
            for key in sorted(value):
                normalized = key.strip().lower().replace("-", "_")
                if (
                    normalized in _SECRET_KEYS
                    or normalized in _PRESENTATION_KEYS
                    or normalized in _PRIVATE_RUNTIME_KEYS
                    or any(normalized.endswith(suffix) for suffix in _SECRET_SUFFIXES)
                ):
                    continue
                safe[key] = cls._safe_value(value[key])
            return safe
        if isinstance(value, list):
            return [cls._safe_value(item) for item in value]
        return value

    @classmethod
    def _bounded_fields(cls, fields: dict[str, Any]) -> dict[str, Any]:
        included: dict[str, Any] = {}
        omitted: list[str] = []
        for key in sorted(fields):
            candidate = {**included, key: fields[key]}
            if len(cls._json(candidate)) <= 7_800:
                included = candidate
            else:
                omitted.append(key)
        if omitted:
            included["omitted_fields"] = omitted
        return included

    @staticmethod
    def _title(fields: dict[str, Any], fallback: str) -> str:
        for key in ("title", "name", "label", "text", "prompt", "key", "operation"):
            value = fields.get(key)
            if isinstance(value, str) and value.strip():
                return value[:500]
        return fallback[:500]

    @staticmethod
    def _primary_domain(domains: set[str]) -> str:
        return min(domains, key=_DOMAINS.index)

    @classmethod
    def _package(
        cls,
        captured: ImpactAnalysisInput,
        request: ImpactResolutionRequest,
        findings: tuple[ImpactFinding, ...],
        resources: list[ImpactResolutionContextResource],
        glossary: list[ImpactResolutionGlossaryEntry],
        omitted_count: int,
        omitted_domains: set[str],
        approved_memory: ApprovedAgentMemoryV1,
    ) -> dict[str, Any]:
        return {
            "project_id": captured.project_id,
            "saved_revision": captured.saved_revision,
            "history_revision": captured.history_revision,
            "source_checksum": captured.source_checksum,
            "approved_memory": approved_memory,
            "request": request,
            "findings": findings,
            "resources": resources,
            "glossary": glossary,
            "omitted_resource_count": omitted_count,
            "omitted_domains": tuple(sorted(omitted_domains)),
        }

    @classmethod
    def _characters(cls, package: dict[str, Any]) -> int:
        serializable = {
            key: (
                [item.model_dump(mode="json") for item in value]
                if isinstance(value, (list, tuple)) and value and isinstance(value[0], BaseModel)
                else value.model_dump(mode="json") if isinstance(value, BaseModel)
                else value
            )
            for key, value in package.items()
        }
        return len(cls._json(serializable))

    @staticmethod
    def _json(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
