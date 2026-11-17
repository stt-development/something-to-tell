"""Immutable UoW project boundary shared by both SQL dialects.

The optional scope is supplied only by the runtime session owner. Unbound UoWs
remain available for legacy process-database APIs and explicit provisioning.
"""

from sqlalchemy import or_, select, update

from ..db import models

# Only schema-owned reference fields are inspected; authored prose, aliases and
# arbitrary metadata are not interpreted as ids or rewritten.
REFERENCE_MODELS = {
    **dict.fromkeys(("node_id", "dialogue_node_id", "quest_node_id", "scene_node_id",
                     "source_node_id", "target_node_id", "context_node_id", "speaker_node_id",
                     "quest_giver_node_id", "item_node_id", "holder_node_id"), models.Node),
    "edge_id": models.Edge, "flow_id": models.StoryFlow,
    "transition_id": models.FlowTransition, "invocation_id": models.FlowInvocation,
    "exit_id": models.FlowExit, "effect_id": models.NarrativeEffect,
}


def validate_json_references(session, value, *, check_reference=None):
    """Inspect typed reference objects without resolving or exposing foreign data."""
    check_reference = check_reference or _reject_foreign_reference
    if isinstance(value, list):
        for item in value:
            validate_json_references(session, item, check_reference=check_reference)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key == "metadata":
                continue  # Authored extension data is not a reference contract.
            if key == "project_id":
                require_project(session, item)
            model = REFERENCE_MODELS.get(key)
            if model is not None and isinstance(item, str):
                check_reference(session, model.__table__, item)
            if key in {"participants", "prerequisite_node_ids", "reward_node_ids", "exit_node_ids"} and isinstance(item, list):
                for identity in item:
                    check_reference(session, models.Node.__table__, identity)
            validate_json_references(session, item, check_reference=check_reference)


def _reject_foreign_reference(session, table, identity):
    scope = session.info["project_scope"]
    if session.scalar(select(table.c.id).where(table.c.id == identity, table.c.project_id == scope)) is not None:
        return
    found = session.scalar(select(table.c.id).where(table.c.id == identity, table.c.project_id != scope))
    if found is not None:
        raise ProjectScopeError()


class ProjectScopeError(ValueError):
    """Deliberately contains no foreign object details."""

    def __init__(self):
        super().__init__("project_scope_mismatch")


def require_project(session, project_id):
    scope = session.info.get("project_scope")
    if scope is not None and project_id != scope:
        raise ProjectScopeError()


def scoped_statement(session, model, statement):
    scope = session.info.get("project_scope")
    if scope is not None:
        column = model.id if model is models.Project else model.project_id
        statement = statement.where(column == scope)
    return statement


def validate_entity(session, model_type, entity, *, check_reference=None):
    """Reject ownership transfers and cross-project relational references pre-flush.

    Nested/JSON domain references are additionally validated as a complete document
    before a selected-session transaction commits, using existing domain contracts.
    """
    scope = session.info.get("project_scope")
    if scope is None:
        return
    check_reference = check_reference or _reject_foreign_reference
    require_project(session, entity.id if model_type is models.Project else entity.project_id)
    json_values = []
    if model_type is models.Node:
        json_values = [entity.metadata.get(key) for key in ("dialogue_document", "quest_document")]
    elif model_type is models.EngineTagBinding:
        json_values = [entity.owner]
    elif model_type is models.NarrativeEffect:
        json_values = [entity.payload]
    elif model_type is models.AgentMemory:
        json_values = [entity.scope]
    elif model_type is models.Suggestion:
        json_values = [entity.patch]
    elif model_type is models.EngineTag:
        target = {"node": models.Node, "edge": models.Edge, "project": models.Project}.get(entity.target_type)
        if target is models.Project:
            require_project(session, entity.target_id)
        elif target is not None:
            check_reference(session, target.__table__, entity.target_id)
    for value in json_values:
        validate_json_references(session, value, check_reference=check_reference)
    for constraint in model_type.__table__.foreign_key_constraints:
        if constraint.referred_table is models.Project.__table__:
            continue
        for fk in constraint.elements:
            if fk.column.name == "id":
                value = getattr(entity, fk.parent.key, None)
                if value is not None:
                    check_reference(session, fk.column.table, value)


def validate_entities(session, model_type, entities):
    """Run the identical ownership walker with fresh, bounded reference queries.

    The collection is local to this call, not a validation cache. Check local ids
    first: independent project copies intentionally share canonical record ids.
    Missing ids with no foreign match keep single-add semantics (FK/domain checks
    remain responsible for existence). Never select foreign project details.
    """
    references = {}

    def collect(_session, table, identity):
        references.setdefault(table, set()).add(identity)

    for entity in entities:
        validate_entity(session, model_type, entity, check_reference=collect)
    # Every owner above is validated before any same-group id can count as local.
    # Only Node JSON can refer inside these groups; SQL self-FK repositories keep
    # their ordered custom-add fallback. A failed insert rolls back all promises.
    own_nodes = {entity.id for entity in entities} if model_type is models.Node else set()
    scope = session.info.get("project_scope")
    for table, identities in references.items():
        ordered = sorted(identities - own_nodes if table is models.Node.__table__ else identities)
        # Stay below SQLite's conservative bind-variable ceiling as well as PG's.
        for start in range(0, len(ordered), 400):
            batch = ordered[start:start + 400]
            local = set(session.scalars(select(table.c.id).where(
                table.c.project_id == scope, table.c.id.in_(batch))))
            missing = set(batch) - local
            if missing and session.scalar(select(table.c.id).where(
                table.c.project_id != scope, table.c.id.in_(sorted(missing))).limit(1)) is not None:
                raise ProjectScopeError()


def validate_delete(session, model_type, model):
    """Clear only nullable reference components; ownership must never become NULL.

    Composite FKs prohibit cross-project cascades in the database itself. The
    explicit cleanup retains previous SET NULL behavior without clearing scope.
    """
    project_id = model.id if model_type is models.Project else model.project_id
    if model_type is models.Node:
        edge_ids = select(models.Edge.id).where(models.Edge.project_id == project_id,
            or_(models.Edge.source_node_id == model.id, models.Edge.target_node_id == model.id))
        session.execute(update(models.Issue).where(models.Issue.project_id == project_id,
            models.Issue.edge_id.in_(edge_ids)).values(edge_id=None))
        session.execute(update(models.Issue).where(models.Issue.project_id == project_id,
            models.Issue.node_id == model.id).values(node_id=None))
        session.execute(update(models.StoryFlow).where(models.StoryFlow.project_id == project_id,
            models.StoryFlow.entry_node_id == model.id).values(entry_node_id=None))
    elif model_type is models.Edge:
        session.execute(update(models.Issue).where(models.Issue.project_id == project_id,
            models.Issue.edge_id == model.id).values(edge_id=None))
