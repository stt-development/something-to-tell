# Pinned Storage Workloads

Portable source projects with exactly **1,000** and **10,000** nodes are stored as
`storage-scale-1000.v1.json.gz` and `storage-scale-10000.v1.json.gz`.
`manifest.v1.json` pins their seed, compressed/JSON SHA-256, canonical document
checksums and collection counts. No database, credentials or lock files are stored.

Normal benchmarks and representative fixture tests load these files, verify their
integrity and never regenerate them. A benchmark still imports an isolated fresh
project/database so writes cannot contaminate subsequent measurements.

Extract a portable JSON project:

```bash
uv run python -m services.runtime.scripts.scale_fixture_files \
  --extract 1000 --output /tmp/storage-scale-1000.json
```

Use `--extract 10000` for the larger project. Explicit maintainer commands:

```bash
uv run python -m services.runtime.scripts.scale_fixture_files --check
uv run python -m services.runtime.scripts.scale_fixture_files --write
```

`--check` regenerates in memory to detect seed/generator drift; `--write` explicitly
replaces both packs and their manifest. Neither runs during ordinary benchmarks.
Updating fixtures requires reviewing counts/checksums and collecting a new baseline,
not silently overwriting historical measurement provenance.

Frontend policy measurements additionally derive **root_grid_v1** in memory from
the checked-in 1000-node pack. Only root coordinates change; descendant offsets
and all other records remain intact. This is a separately named geometry variant,
not a replacement pack or an automatic project layout. Reproduce the sanitized
raw-placement report (not DOM/latency measurements):

```bash
node apps/web/performance/rendering-policy.mjs
```

See [rendering policy and limits](../../docs/architecture/canvas-rendering-policy.md).

`root_grid_v1` is also available for owned browser measurements and manual copies:

```bash
uv run python -m services.runtime.scripts.prepare_frontend_baseline \
  /tmp/stt-frontend-baseline-root-grid --size 1000 --variant root_grid_v1
```

This development helper requires Node and reuses `spreadPlacements` from the
frontend policy instead of defining another layout algorithm. Only root placement
coordinates and the copy's display name/slug change. Descendant offsets, sizes,
canonical nodes (including unplaced nodes), relations, tags and flows remain exact.
The original compressed packs are never modified. This regular grid separates
root groups; it is a layout sensitivity diagnostic, not proof of representative
real-world graph topology or a replacement for the dense stress workload.

Репрезентативные проекты зафиксированы в файлах: обычные тесты и benchmark читают
их без повторной генерации. Свежая временная БД создаётся для изоляции изменений.
`--extract` распаковывает проект в JSON; `--check` проверяет совпадение с генератором,
а `--write` явно обновляет оба набора. Подробнее:
[EN/RU workflow](../../docs/examples/storage-scale.md).
