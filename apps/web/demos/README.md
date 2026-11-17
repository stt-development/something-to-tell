# README Demonstrations

`readme.spec.ts` is an opt-in Playwright capture, not part of normal `e2e/`
discovery. It uses the real UI and a disposable project, asserts three authored
nodes and two runtime relationships, then discards and closes only its own session.

Use isolated local processes: runtime on8875 with a disposable HOME, database and
profile paths, and Vite on1425 with `VITE_RUNTIME_URL=http://127.0.0.1:8875/api`.
Allow that frontend origin in runtime settings. Never reuse a personal project
or record provider/settings windows containing credentials. Stop both owned
processes when finished.

```bash
pnpm --dir apps/web exec playwright test demos/readme.spec.ts --workers=1
pnpm --dir apps/web exec playwright test demos/story-flow.spec.ts --workers=1
```

Override `STT_DEMO_ORIGIN`/`STT_DEMO_API` for another isolated pair. Raw video,
timing.json and the final screenshot are in ignored `apps/web/test-results/`.
The recorded project menu is closed before the first published timestamp so no
machine-local project path enters the clips. The capture checks native source-port
hits before dragging and persists each edge through the existing runtime API.

Trim by `createStart/createEnd` and `connectStart/connectEnd` from timing.json.
The reviewed files in `docs/guides/assets/demos/` are documentation assets, not
raw test output. GIFs use960x600,12fps, a96-color palette and infinite looping;
WebM uses1280x800 VP9 without audio. Inspect first/middle/final frames and verify
duration/decoding with ffprobe before replacing curated assets. Re-record rather
than silently updating screenshots or videos during CI. README/link/header/size
checks run in `pnpm public-source:test`.

`story-flow.spec.ts` imports the fictional export-ready Aurora fixture into a new
temporary folder, edits prose inline in Story, follows the expanded subflow and
inspects branching transitions in Flow. It verifies the persisted text and releases
only its own session. `STT_DEMO_PYTHON` can override the repository `.venv/bin/python`
used by the fixture importer. Trim its `storyStart/storyEnd` and `flowStart/flowEnd`
segments into `story-view` and `flow-view`; never publish the project-picker setup.
