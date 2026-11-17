# Migration Versions

Generated Alembic revision files belong in this directory. The current linear
head is `20261021_0010`: project-relative primary keys, references and aggregate
uniqueness for SQLite/PostgreSQL. It preserves canonical ids and authored rows,
preflights ownership/reference integrity and refuses lossy downgrade. SQLite batch
DDL runs in one explicit transaction; remote upgrades require stopped legacy
writers and a verified operator backup. Earlier `20260919_0009` retains Engine Tag
quarantine; `20260911_0008` adds portable reviewed agent memory.

See [EN/RU upgrade guide](../../../../docs/examples/project-copies-and-schema-upgrades.md).
