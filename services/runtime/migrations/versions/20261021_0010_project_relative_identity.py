"""P9-003 project-relative identities; preserve canonical ids and authored data.

Requires stopped legacy writers and a verified backup for shared PostgreSQL.
Never import mutable runtime metadata into this historical migration.
"""

from alembic import op
import sqlalchemy as sa

revision = "20261021_0010"
down_revision = "20260919_0009"
branch_labels = None
depends_on = None

# Frozen v9 relationship inventory; project ownership FKs remain unchanged.
REFERENCES = {
    "agent_memories": [],
    "engine_tag_definitions": [],
    "engine_tags": [],
    "impact_resolution_decisions": [],
    "legacy_engine_tags": [],
    "narrative_effects": [],
    "nodes": [],
    "style_profiles": [],
    "suggestions": [],
    "edges": [
        {
            "column": "target_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "source_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        }
    ],
    "engine_tag_bindings": [
        {
            "column": "definition_id",
            "target": "engine_tag_definitions",
            "ondelete": "CASCADE"
        }
    ],
    "narrative_effect_bindings": [
        {
            "column": "context_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "effect_id",
            "target": "narrative_effects",
            "ondelete": "CASCADE"
        }
    ],
    "scene_style_assignments": [
        {
            "column": "style_profile_id",
            "target": "style_profiles",
            "ondelete": "RESTRICT"
        },
        {
            "column": "scene_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        }
    ],
    "story_flows": [
        {
            "column": "entry_node_id",
            "target": "nodes",
            "ondelete": "SET NULL"
        }
    ],
    "visual_placements": [
        {
            "column": "canonical_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "container_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        }
    ],
    "flow_exits": [
        {
            "column": "flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        },
        {
            "column": "source_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        }
    ],
    "flow_initial_states": [
        {
            "column": "flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        }
    ],
    "flow_invocations": [
        {
            "column": "source_flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        },
        {
            "column": "target_flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        },
        {
            "column": "source_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        }
    ],
    "flow_transitions": [
        {
            "column": "target_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "source_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        }
    ],
    "issues": [
        {
            "column": "edge_id",
            "target": "edges",
            "ondelete": "SET NULL"
        },
        {
            "column": "node_id",
            "target": "nodes",
            "ondelete": "SET NULL"
        }
    ],
    "scene_flow_boundaries": [
        {
            "column": "flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        },
        {
            "column": "entry_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "scene_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        }
    ],
    "story_flow_nodes": [
        {
            "column": "node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "flow_id",
            "target": "story_flows",
            "ondelete": "CASCADE"
        }
    ],
    "flow_exit_bindings": [
        {
            "column": "target_node_id",
            "target": "nodes",
            "ondelete": "CASCADE"
        },
        {
            "column": "exit_id",
            "target": "flow_exits",
            "ondelete": "CASCADE"
        },
        {
            "column": "invocation_id",
            "target": "flow_invocations",
            "ondelete": "CASCADE"
        }
    ]
}


def _preflight(bind, inspector):
    expected = set(REFERENCES) | {"projects", "alembic_version"}
    if set(inspector.get_table_names()) != expected:
        raise RuntimeError("project_identity_schema_incompatible: verify the v9 schema before upgrading")
    metadata = sa.MetaData()
    metadata.reflect(bind=bind)
    for name in REFERENCES:
        table = metadata.tables[name]
        if inspector.get_pk_constraint(name)["constrained_columns"] != ["id"]:
            raise RuntimeError("project_identity_schema_incompatible: expected v9 global keys")
        expected_fks = [(('project_id',), 'projects', ('id',), 'CASCADE')]
        expected_fks.extend(((item["column"],), item["target"], ('id',), item["ondelete"])
                            for item in REFERENCES[name])
        actual_fks = [(tuple(item["constrained_columns"]), item["referred_table"],
                       tuple(item["referred_columns"]), item.get("options", {}).get("ondelete"))
                      for item in inspector.get_foreign_keys(name)]
        if sorted(actual_fks) != sorted(expected_fks):
            raise RuntimeError("project_identity_schema_incompatible: unexpected v9 reference constraints")
        if bind.scalar(sa.select(sa.literal(1)).select_from(table).where(table.c.project_id.is_(None)).limit(1)):
            raise RuntimeError("project_identity_owner_invalid: repair project ownership before upgrading")
        for constraint in table.foreign_key_constraints:
            target = constraint.referred_table
            column = next(element.parent for element in constraint.elements)
            # Reject orphan and cross-project rows before the first DDL statement.
            valid = target.c.id == column
            if target.name != "projects":
                valid = sa.and_(valid, target.c.project_id == table.c.project_id)
            query = sa.select(sa.literal(1)).select_from(table.outerjoin(target, valid)).where(
                column.is_not(None), target.c.id.is_(None)).limit(1)
            if bind.scalar(query):
                raise RuntimeError("project_identity_reference_invalid: repair orphan/cross-project references before upgrading")


def _fk_name(table, fk):
    return fk["name"] or f"fk_{table}_{fk['constrained_columns'][0]}_{fk['referred_table']}"


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    _preflight(bind, inspector)
    # Inspect once: subsequent constraints/keys are replaced in dependency order.
    keys = {name: inspector.get_pk_constraint(name) for name in REFERENCES}
    fks = {name: [fk for fk in inspector.get_foreign_keys(name) if fk["referred_table"] != "projects"]
           for name in REFERENCES}
    uniques = {name: [value for value in inspector.get_unique_constraints(name)
                      if "project_id" not in value["column_names"]] for name in REFERENCES}
    if bind.dialect.name == "postgresql":
        for name, constraints in fks.items():
            for fk in constraints:
                op.drop_constraint(fk["name"], name, type_="foreignkey")
        for name in REFERENCES:
            op.drop_constraint(keys[name]["name"], name, type_="primary")
            op.create_primary_key(f"pk_{name}", name, ["project_id", "id"])
            for value in uniques[name]:
                op.drop_constraint(value["name"], name, type_="unique")
                op.create_unique_constraint(value["name"], name, ["project_id", *value["column_names"]])
        for name in REFERENCES:
            for fk in REFERENCES[name]:
                action = "RESTRICT" if fk["ondelete"] == "SET NULL" else fk["ondelete"]
                op.create_foreign_key(f"fk_{fk['column']}_{fk['target']}_project", name, fk["target"],
                                     ["project_id", fk["column"]], ["project_id", "id"], ondelete=action)
    elif bind.dialect.name == "sqlite":
        # env.py holds one explicit SQLite transaction with FKs disabled during
        # table replacement. Preflight and final foreign_key_check bracket DDL.
        naming = {"pk": "pk_%(table_name)s",
                  "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}
        for name in REFERENCES:
            with op.batch_alter_table(name, recreate="always", naming_convention=naming) as batch:
                for fk in fks[name]:
                    batch.drop_constraint(_fk_name(name, fk), type_="foreignkey")
                batch.drop_constraint(keys[name]["name"] or f"pk_{name}", type_="primary")
                batch.create_primary_key(f"pk_{name}", ["project_id", "id"])
                for value in uniques[name]:
                    batch.drop_constraint(value["name"], type_="unique")
                    batch.create_unique_constraint(value["name"], ["project_id", *value["column_names"]])
                for fk in REFERENCES[name]:
                    action = "RESTRICT" if fk["ondelete"] == "SET NULL" else fk["ondelete"]
                    batch.create_foreign_key(f"fk_{fk['column']}_{fk['target']}_project", fk["target"],
                                             ["project_id", fk["column"]], ["project_id", "id"], ondelete=action)
        if bind.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
            raise RuntimeError("project_identity_reference_invalid: restore the pre-upgrade backup")
    else:
        raise RuntimeError("project_identity_dialect_unsupported")


def downgrade():
    # Colliding canonical ids cannot be represented by the old global key. Do
    # not remap authored references or destroy a copy merely to downgrade.
    raise RuntimeError("project_identity_downgrade_requires_verified_backup_restore")
