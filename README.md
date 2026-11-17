# Something To Tell Engine

*Visual authoring for branching stories*

Desktop-first, local-first narrative authoring for branching stories.

## Write And Test A Story

- Arrange Characters, Scenes, Locations, Dialogue, Quests, Items and story facts.
- Connect story steps and reusable flows, then read them as text or try branches
  in Playback.
- Check consistency and the impact of changes; review optional AI-assisted fixes
  and style recommendations before applying them.
- Save locally, or use a configured PostgreSQL database with one active writer.
- Preview and export JSON, YAML, Ink and Yarn Spinner.

The interface and user guides are available in English and Russian. Open **?**
in the project header or **User guides** on the startup screen. Guides and images
are bundled with the frontend, with no online documentation service required.

## User Guides

- [All topics, English and Russian](docs/guides/README.md)
- [Your first story](docs/guides/getting-started.en.md) /
  [Первая история](docs/guides/getting-started.ru.md)
- [Projects and saving](docs/guides/projects.en.md) /
  [Проекты и сохранение](docs/guides/projects.ru.md)
- [Export](docs/guides/export.en.md) /
  [Экспорт](docs/guides/export.ru.md)

## Development

Requirements: Node.js22, pnpm10.15.0, Python3.13 with uv, and Rust with the
platform prerequisites for Tauri2. Use the checked-in lockfiles.

```bash
pnpm install --frozen-lockfile
uv sync --all-extras --locked
```

Start the local backend in one terminal:

```bash
pnpm runtime:dev
```

In another terminal, choose the browser frontend **or** the Tauri development app:

```bash
pnpm web:dev
# Alternatively: pnpm desktop:dev
```

The browser frontend uses http://127.0.0.1:1420 and the local backend uses
http://127.0.0.1:8719. The Tauri development command starts its own frontend;
do not start both frontend commands on the same port. Browser and Tauri development
require the backend separately. Experimental packaged candidates start a verified
bundled runtime through a private connection; bundling requires a verified runtime
resource override. Native lifecycle and platform acceptance remain in progress.
Standalone installers are still being prepared.
Manual native candidate workflows also require a reviewed, nonempty
`THIRD_PARTY_NOTICES.md` before binary upload. That notice bundle is not yet
complete; workflow definitions and local probes are not release certification.

## Tests

The public aggregate runs source/dependency guards, desktop configuration,
backend tests, guide content checks, frontend tests, type checking and build:

```bash
pnpm verify:public
```

Individual commands:

```bash
pnpm web:typecheck
pnpm web:test
pnpm web:build
pnpm runtime:test
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Browser workflows use Playwright and require the backend/frontend to be running:

```bash
pnpm --dir apps/web exec playwright install chromium
pnpm web:test:e2e
```

Database integration tests require a disposable PostgreSQL instance; exporter
compiler tests require the relevant Ink/Yarn compiler. Missing prerequisites
must not be interpreted as passing integration coverage. The public aggregate
explicitly excludes only private-document checks: application-map/phase-loop
references, original-example provenance, and Python tests marked
`internal_documentation` for archived reports or specification parity.
Functional Python/TypeScript wire-contract tests remain included. The unfiltered
`verify:foundation` command additionally requires the private documentation tree.
Performance tools and fixtures are included but are not part of release test runs.

## Project Data

Every editable project owns a local .narrative folder, including when its active
storage is PostgreSQL. Local projects work offline; remote storage requires its
database connection. Each remote project permits one active writer at a time.
Save As creates a portable local copy; export files are not complete project backups.
Keep personal project folders, credentials, environments and generated artifacts
out of source control. Large-project responsiveness remains subject to practical
limits; do not assume certification for a particular project size.

## Repository Layout

- apps/desktop: Tauri desktop shell.
- apps/web: React frontend and browser tests.
- services/runtime: Python backend, migrations and tests.
- packages/contracts: shared contracts.
- docs/guides: bilingual user documentation and screenshots.
- fixtures: reproducible test/example data.

## License

The original application source code is licensed under the GNU General Public
License, version3 or (at your option) any later version
(SPDX-License-Identifier: GPL-3.0-or-later). See [LICENSE](LICENSE).
Third-party components retain their own licenses and notices. Commercial use and
redistribution are permitted under the license; distributed derivative versions
must meet its corresponding-source and licensing requirements. No warranty is
provided except where applicable law requires otherwise.

Using the application does not by itself put your independently authored stories,
dialogue, projects or other original output under this application's license.
Included third-party material remains subject to its own terms. The license
declaration does not replace a dependency and asset license audit.
