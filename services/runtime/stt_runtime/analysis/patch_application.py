from __future__ import annotations

from dataclasses import replace

from ..domain.entities import EdgeEntity, NodeEntity, SuggestionEntity
from ..engine_tags.automatic import add_node_with_automatic_tag, add_relationship_with_automatic_tag
from ..repositories.interfaces import UnitOfWork
from ..schemas.scene_analysis import CreateEdgeOperation, CreateNodeOperation, GraphPatch, UpdateEdgeOperation, UpdateNodeOperation


class PatchApplicationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SuggestionDecisionService:
    """Applies or rejects stored suggestions behind an explicit user decision."""

    def approve(self, uow: UnitOfWork, suggestion_id: str) -> SuggestionEntity:
        suggestion = self._pending_suggestion(uow, suggestion_id)
        patch = GraphPatch.model_validate(suggestion.patch)
        self._validate_patch(uow, suggestion.project_id, patch)

        client_node_ids: dict[str, str] = {}
        for operation in patch.operations:
            if isinstance(operation, CreateNodeOperation):
                node = add_node_with_automatic_tag(
                    uow,
                    NodeEntity(
                        project_id=suggestion.project_id,
                        type=operation.node.kind,
                        title=operation.node.title,
                        summary=operation.node.summary,
                        body=operation.node.body,
                        status="canon",
                        metadata=operation.node.metadata,
                    )
                )
                client_node_ids[operation.client_id] = node.id
            elif isinstance(operation, UpdateNodeOperation):
                existing = self._project_node(uow, suggestion.project_id, operation.node_id)
                updates = operation.updates
                uow.nodes.update(
                    replace(
                        existing,
                        title=updates.title if updates.title is not None else existing.title,
                        summary=updates.summary if updates.summary is not None else existing.summary,
                        body=updates.body if updates.body is not None else existing.body,
                        status=updates.status if updates.status is not None else existing.status,
                        metadata=updates.metadata if updates.metadata is not None else existing.metadata,
                    )
                )

        for operation in patch.operations:
            if isinstance(operation, CreateEdgeOperation):
                source_id = operation.edge.source.node_id or client_node_ids[operation.edge.source.client_id or ""]
                target_id = operation.edge.target.node_id or client_node_ids[operation.edge.target.client_id or ""]
                add_relationship_with_automatic_tag(
                    uow,
                    EdgeEntity(
                        project_id=suggestion.project_id,
                        source_node_id=source_id,
                        target_node_id=target_id,
                        type=operation.edge.relationship_type,
                        label=operation.edge.label,
                        condition=operation.edge.condition,
                        metadata=operation.edge.metadata,
                    ),
                )
            elif isinstance(operation, UpdateEdgeOperation):
                existing = self._project_edge(uow, suggestion.project_id, operation.edge_id)
                updates = operation.updates
                uow.edges.update(
                    replace(
                        existing,
                        type=updates.relationship_type if updates.relationship_type is not None else existing.type,
                        label=updates.label if updates.label is not None else existing.label,
                        condition=updates.condition if updates.condition is not None else existing.condition,
                        metadata=updates.metadata if updates.metadata is not None else existing.metadata,
                    )
                )

        approved = uow.suggestions.update(
            replace(
                suggestion,
                status="approved",
                metadata={**suggestion.metadata, "applied_operation_count": len(patch.operations)},
            )
        )
        uow.commit()
        return approved

    def reject(self, uow: UnitOfWork, suggestion_id: str) -> SuggestionEntity:
        suggestion = self._pending_suggestion(uow, suggestion_id)
        rejected = uow.suggestions.update(replace(suggestion, status="rejected"))
        uow.commit()
        return rejected

    def approve_operation(self, uow: UnitOfWork, suggestion_id: str, operation_index: int) -> SuggestionEntity:
        suggestion, patch, decisions = self._reviewable_operation(uow, suggestion_id, operation_index)
        operation = patch.operations[operation_index]
        client_node_ids = self._client_node_ids(suggestion)
        self._validate_single_operation(uow, suggestion.project_id, operation, client_node_ids)
        self._apply_single_operation(uow, suggestion.project_id, operation, client_node_ids)
        decisions[str(operation_index)] = "approved"
        updated = self._update_operation_decision(uow, suggestion, patch, decisions, client_node_ids)
        uow.commit()
        return updated

    def reject_operation(self, uow: UnitOfWork, suggestion_id: str, operation_index: int) -> SuggestionEntity:
        suggestion, patch, decisions = self._reviewable_operation(uow, suggestion_id, operation_index)
        decisions[str(operation_index)] = "rejected"
        updated = self._update_operation_decision(uow, suggestion, patch, decisions, self._client_node_ids(suggestion))
        uow.commit()
        return updated

    def _reviewable_operation(
        self, uow: UnitOfWork, suggestion_id: str, operation_index: int
    ) -> tuple[SuggestionEntity, GraphPatch, dict[str, str]]:
        suggestion = uow.suggestions.get(suggestion_id)
        if suggestion is None:
            raise PatchApplicationError("suggestion_not_found", f"Suggestion not found: {suggestion_id}")
        patch = GraphPatch.model_validate(suggestion.patch)
        if operation_index < 0 or operation_index >= len(patch.operations):
            raise PatchApplicationError("operation_not_found", f"Suggestion operation not found: {operation_index}")
        decisions = self._operation_decisions(suggestion)
        if str(operation_index) in decisions:
            raise PatchApplicationError("operation_already_decided", f"Suggestion operation is already {decisions[str(operation_index)]}: {operation_index}")
        if len(decisions) >= len(patch.operations):
            raise PatchApplicationError("suggestion_already_decided", f"Suggestion is already {suggestion.status}: {suggestion_id}")
        return suggestion, patch, decisions

    def _validate_single_operation(
        self, uow: UnitOfWork, project_id: str, operation: object, client_node_ids: dict[str, str]
    ) -> None:
        if isinstance(operation, UpdateNodeOperation):
            self._project_node(uow, project_id, operation.node_id)
        elif isinstance(operation, UpdateEdgeOperation):
            self._project_edge(uow, project_id, operation.edge_id)
        elif isinstance(operation, CreateEdgeOperation):
            for endpoint in (operation.edge.source, operation.edge.target):
                if endpoint.node_id is not None:
                    self._project_node(uow, project_id, endpoint.node_id)
                elif endpoint.client_id not in client_node_ids:
                    raise PatchApplicationError(
                        "dependency_not_approved", f"Approve the referenced node before this edge: {endpoint.client_id}"
                    )

    def _apply_single_operation(
        self, uow: UnitOfWork, project_id: str, operation: object, client_node_ids: dict[str, str]
    ) -> None:
        if isinstance(operation, CreateNodeOperation):
            node = add_node_with_automatic_tag(
                uow,
                NodeEntity(
                    project_id=project_id,
                    type=operation.node.kind,
                    title=operation.node.title,
                    summary=operation.node.summary,
                    body=operation.node.body,
                    status="canon",
                    metadata=operation.node.metadata,
                )
            )
            client_node_ids[operation.client_id] = node.id
        elif isinstance(operation, UpdateNodeOperation):
            existing = self._project_node(uow, project_id, operation.node_id)
            updates = operation.updates
            uow.nodes.update(
                replace(
                    existing,
                    title=updates.title if updates.title is not None else existing.title,
                    summary=updates.summary if updates.summary is not None else existing.summary,
                    body=updates.body if updates.body is not None else existing.body,
                    status=updates.status if updates.status is not None else existing.status,
                    metadata=updates.metadata if updates.metadata is not None else existing.metadata,
                )
            )
        elif isinstance(operation, CreateEdgeOperation):
            source_id = operation.edge.source.node_id or client_node_ids[operation.edge.source.client_id or ""]
            target_id = operation.edge.target.node_id or client_node_ids[operation.edge.target.client_id or ""]
            add_relationship_with_automatic_tag(
                uow,
                EdgeEntity(
                    project_id=project_id,
                    source_node_id=source_id,
                    target_node_id=target_id,
                    type=operation.edge.relationship_type,
                    label=operation.edge.label,
                    condition=operation.edge.condition,
                    metadata=operation.edge.metadata,
                ),
            )
        elif isinstance(operation, UpdateEdgeOperation):
            existing = self._project_edge(uow, project_id, operation.edge_id)
            updates = operation.updates
            uow.edges.update(
                replace(
                    existing,
                    type=updates.relationship_type if updates.relationship_type is not None else existing.type,
                    label=updates.label if updates.label is not None else existing.label,
                    condition=updates.condition if updates.condition is not None else existing.condition,
                    metadata=updates.metadata if updates.metadata is not None else existing.metadata,
                )
            )

    def _update_operation_decision(
        self,
        uow: UnitOfWork,
        suggestion: SuggestionEntity,
        patch: GraphPatch,
        decisions: dict[str, str],
        client_node_ids: dict[str, str],
    ) -> SuggestionEntity:
        decision_values = list(decisions.values())
        all_decided = len(decisions) == len(patch.operations)
        status = "pending"
        if all_decided and all(value == "approved" for value in decision_values):
            status = "approved"
        elif all_decided and all(value == "rejected" for value in decision_values):
            status = "rejected"
        elif all_decided:
            status = "reviewed"
        return uow.suggestions.update(
            replace(
                suggestion,
                status=status,
                metadata={
                    **suggestion.metadata,
                    "operation_decisions": decisions,
                    "client_node_ids": client_node_ids,
                    "applied_operation_count": sum(value == "approved" for value in decision_values),
                },
            )
        )

    def _operation_decisions(self, suggestion: SuggestionEntity) -> dict[str, str]:
        value = suggestion.metadata.get("operation_decisions", {})
        return {str(key): str(decision) for key, decision in value.items()} if isinstance(value, dict) else {}

    def _client_node_ids(self, suggestion: SuggestionEntity) -> dict[str, str]:
        value = suggestion.metadata.get("client_node_ids", {})
        return {str(key): str(node_id) for key, node_id in value.items()} if isinstance(value, dict) else {}

    def _validate_patch(self, uow: UnitOfWork, project_id: str, patch: GraphPatch) -> None:
        create_node_ids = {operation.client_id for operation in patch.operations if isinstance(operation, CreateNodeOperation)}
        if len(create_node_ids) != sum(isinstance(operation, CreateNodeOperation) for operation in patch.operations):
            raise PatchApplicationError("invalid_patch", "Patch contains duplicate node client ids.")

        for operation in patch.operations:
            if isinstance(operation, UpdateNodeOperation):
                self._project_node(uow, project_id, operation.node_id)
            elif isinstance(operation, UpdateEdgeOperation):
                self._project_edge(uow, project_id, operation.edge_id)
            elif isinstance(operation, CreateEdgeOperation):
                for endpoint in (operation.edge.source, operation.edge.target):
                    if endpoint.node_id is not None:
                        self._project_node(uow, project_id, endpoint.node_id)
                    elif endpoint.client_id not in create_node_ids:
                        raise PatchApplicationError("stale_patch", f"Patch node reference is unavailable: {endpoint.client_id}")

    def _pending_suggestion(self, uow: UnitOfWork, suggestion_id: str) -> SuggestionEntity:
        suggestion = uow.suggestions.get(suggestion_id)
        if suggestion is None:
            raise PatchApplicationError("suggestion_not_found", f"Suggestion not found: {suggestion_id}")
        if suggestion.status != "pending":
            raise PatchApplicationError("suggestion_already_decided", f"Suggestion is already {suggestion.status}: {suggestion_id}")
        return suggestion

    def _project_node(self, uow: UnitOfWork, project_id: str, node_id: str) -> NodeEntity:
        node = uow.nodes.get(node_id)
        if node is None or node.project_id != project_id:
            raise PatchApplicationError("stale_patch", f"Patch node is unavailable: {node_id}")
        return node

    def _project_edge(self, uow: UnitOfWork, project_id: str, edge_id: str) -> EdgeEntity:
        edge = uow.edges.get(edge_id)
        if edge is None or edge.project_id != project_id:
            raise PatchApplicationError("stale_patch", f"Patch edge is unavailable: {edge_id}")
        return edge
