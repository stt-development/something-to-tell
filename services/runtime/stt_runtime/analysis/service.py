from __future__ import annotations

import hashlib
import json

from ..domain.entities import SuggestionEntity
from ..repositories.interfaces import UnitOfWork
from ..schemas.scene_analysis import GraphPatch, SceneAnalysisRequest, SceneAnalysisResponse
from .extractor import DeterministicSceneExtractor, SceneExtractor
from .graph_builder import GraphPatchBuilder


class SceneAnalysisError(RuntimeError):
    """Carries a stable API error code across the analysis boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SceneAnalysisService:
    """Coordinates extraction, patch preview, and suggestion persistence."""

    def __init__(self, extractor: SceneExtractor | None = None, graph_builder: GraphPatchBuilder | None = None) -> None:
        self.extractor = extractor or DeterministicSceneExtractor()
        self.graph_builder = graph_builder or GraphPatchBuilder()

    def analyze(self, uow: UnitOfWork, request: SceneAnalysisRequest) -> SceneAnalysisResponse:
        if uow.projects.get(request.project_id) is None:
            raise ValueError(f"Project not found: {request.project_id}")

        existing_nodes = uow.nodes.list(project_id=request.project_id)
        existing_edges = uow.edges.list(project_id=request.project_id)
        try:
            extracted_facts = self.extractor.extract(request)
        except ConnectionError as error:
            raise SceneAnalysisError("provider_unavailable", "The configured analysis provider is unavailable.") from error
        except Exception as error:
            raise SceneAnalysisError("extraction_failed", "Scene facts could not be extracted.") from error
        try:
            patch = self.graph_builder.build_patch(
                existing_edges=existing_edges,
                existing_nodes=existing_nodes,
                extracted_facts=extracted_facts,
                title=request.title,
            )
        except Exception as error:
            raise SceneAnalysisError("patch_validation_failed", "Extracted facts could not be converted into a valid graph patch.") from error
        reviewed_fingerprints = self._reviewed_operation_fingerprints(uow, request.project_id)
        skipped_count = sum(operation_fingerprint(operation) in reviewed_fingerprints for operation in patch.operations)
        if skipped_count:
            patch = patch.model_copy(
                update={"operations": [operation for operation in patch.operations if operation_fingerprint(operation) not in reviewed_fingerprints]}
            )
        suggestion = uow.suggestions.add(
            SuggestionEntity(
                project_id=request.project_id,
                title=patch.title,
                description=patch.description,
                status="pending",
                patch=patch.model_dump(mode="json"),
                metadata={
                    "analysis_provider": self.extractor.provider,
                    "extracted_fact_count": len(extracted_facts),
                    "operation_count": len(patch.operations),
                    "previously_reviewed_operation_count": skipped_count,
                    "scene_title": request.title,
                },
            )
        )
        uow.commit()

        return SceneAnalysisResponse(
            project_id=request.project_id,
            suggestion_id=suggestion.id,
            provider="deterministic",
            extracted_facts=list(extracted_facts),
            patch=patch,
            warnings=(
                [f"{skipped_count} previously reviewed suggestion(s) were omitted."]
                if skipped_count
                else ([] if patch.operations else ["No applicable graph changes were found."])
            ),
        )

    def _reviewed_operation_fingerprints(self, uow: UnitOfWork, project_id: str) -> set[str]:
        """Collect operations that already received a durable human decision."""
        fingerprints: set[str] = set()
        for suggestion in uow.suggestions.list(project_id=project_id):
            try:
                patch = GraphPatch.model_validate(suggestion.patch)
            except ValueError:
                continue
            decisions = suggestion.metadata.get("operation_decisions")
            if isinstance(decisions, dict):
                decided_indexes = {int(index) for index in decisions if str(index).isdigit()}
            elif suggestion.status in {"approved", "rejected"}:
                decided_indexes = set(range(len(patch.operations)))
            else:
                decided_indexes = set()
            fingerprints.update(operation_fingerprint(patch.operations[index]) for index in decided_indexes if index < len(patch.operations))
        return fingerprints


def operation_fingerprint(operation: object) -> str:
    """Return a stable semantic identity while ignoring volatile evidence metadata."""
    payload = operation.model_dump(mode="json")  # type: ignore[attr-defined]
    normalized = _without_metadata(payload)
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _without_metadata(value: object) -> object:
    if isinstance(value, dict):
        return {key: _without_metadata(item) for key, item in value.items() if key != "metadata"}
    if isinstance(value, list):
        return [_without_metadata(item) for item in value]
    return value
