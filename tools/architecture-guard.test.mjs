import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateArchitecture,
  findDependencyCycles,
  parsePythonImports,
  parseTypeScriptImports,
  resolveTypeScriptImport
} from "./architecture-guard.mjs";

test("parsers return stable static Python and TypeScript imports", () => {
  assert.deepEqual(
    parsePythonImports("from ..domain.entities import NodeEntity\nimport json, pathlib as paths\n"),
    ["..domain.entities", "json", "pathlib"]
  );
  assert.deepEqual(
    parseTypeScriptImports("import type { A } from './a';\nexport { B } from \"./b\";\nimport('./c');"),
    ["./a", "./b", "./c"]
  );
});

test("workspace contract exports resolve from kebab-case to camelCase files", () => {
  const knownPaths = new Set(["packages/contracts/src/projectManifest.ts"]);

  assert.equal(
    resolveTypeScriptImport(
      "apps/web/src/runtime/projectClient.ts",
      "@something-to-tell/contracts/project-manifest",
      knownPaths
    ),
    "packages/contracts/src/projectManifest.ts"
  );
});

test("accepted dependency graphs preserve inward contract directions", () => {
  const result = evaluateArchitecture([
    {
      path: "services/runtime/stt_runtime/domain/entities.py",
      content: "from dataclasses import dataclass\n"
    },
    {
      path: "services/runtime/stt_runtime/repositories/interfaces.py",
      content: "from ..domain.entities import NodeEntity\n"
    },
    {
      path: "apps/web/src/story-flow/contracts.ts",
      content: "export interface StoryFlow { id: string }\n"
    },
    {
      path: "apps/web/src/runtime/flowClient.ts",
      content: "import type { StoryFlow } from '../story-flow/contracts';\n"
    },
    {
      path: "apps/web/src/app/story/storyLifecycleController.ts",
      content: "import type { StoryFlow } from '../../../story-flow/contracts';\n"
    }
  ]);

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.checkedCount, 5);
});

test("forbidden Python and TypeScript directions have deterministic diagnostics", () => {
  const result = evaluateArchitecture([
    {
      path: "services/runtime/stt_runtime/domain/entities.py",
      content: "from ..db.models import Node\n"
    },
    {
      path: "services/runtime/stt_runtime/db/models.py",
      content: "class Node: pass\n"
    },
    {
      path: "apps/web/src/app/shared/DialogShell.tsx",
      content: "export const dialog = true;\n"
    },
    {
      path: "apps/web/src/impact/navigation.ts",
      content: "import { dialog } from '../app/shared/DialogShell';\n"
    }
  ]);

  assert.deepEqual(result.diagnostics.map(({ code, source, target }) => ({ code, source, target })), [
    {
      code: "web_policy_imports_app",
      source: "apps/web/src/impact/navigation.ts",
      target: "apps/web/src/app/shared/DialogShell.tsx"
    },
    {
      code: "forbidden_python_import",
      source: "services/runtime/stt_runtime/domain/entities.py",
      target: "services/runtime/stt_runtime/db/models.py"
    }
  ]);
});

test("cycle diagnostics are canonical and independent of insertion order", () => {
  const first = new Map([
    ["b.ts", new Set(["c.ts"])],
    ["a.ts", new Set(["b.ts"])],
    ["c.ts", new Set(["a.ts"])]
  ]);
  const second = new Map([...first.entries()].reverse());

  assert.deepEqual(findDependencyCycles(first), [["a.ts", "b.ts", "c.ts", "a.ts"]]);
  assert.deepEqual(findDependencyCycles(second), findDependencyCycles(first));
});

test("Python from-package imports participate through known child modules", () => {
  const result = evaluateArchitecture([
    {
      path: "services/runtime/stt_runtime/dialogue/service.py",
      content: "from ..quest import service\n"
    },
    {
      path: "services/runtime/stt_runtime/quest/service.py",
      content: "from ..dialogue import service\n"
    }
  ]);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "dependency_cycle");
  assert.match(result.diagnostics[0].detail, /dialogue\/service\.py/);
  assert.match(result.diagnostics[0].detail, /quest\/service\.py/);
});

test("test files do not participate in production dependency ownership", () => {
  const result = evaluateArchitecture([
    {
      path: "apps/web/src/impact/navigation.test.ts",
      content: "import '../app/shared/DialogShell';\n"
    },
    {
      path: "services/runtime/tests/test_dependency.py",
      content: "from services.runtime.stt_runtime.api import dependencies\n"
    }
  ]);

  assert.deepEqual(result, { checkedCount: 0, diagnostics: [] });
});
