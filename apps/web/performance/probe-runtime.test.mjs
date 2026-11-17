import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeRuntimeOrigin } from "./probe-runtime.mjs";

test("probe runtime defaults and isolated loopback origins preserve structured ports", () => {
  assert.equal(probeRuntimeOrigin("http://127.0.0.1:8721/"), "http://127.0.0.1:8721");
  assert.equal(probeRuntimeOrigin("http://localhost:8722"), "http://localhost:8722");
  const prior = process.env.STT_PERF_RUNTIME_ORIGIN;
  try {
    delete process.env.STT_PERF_RUNTIME_ORIGIN;
    assert.equal(probeRuntimeOrigin(), "http://127.0.0.1:8719");
    process.env.STT_PERF_RUNTIME_ORIGIN = "http://127.0.0.1:8721";
    assert.equal(probeRuntimeOrigin(), "http://127.0.0.1:8721");
  } finally {
    if (prior === undefined) delete process.env.STT_PERF_RUNTIME_ORIGIN;
    else process.env.STT_PERF_RUNTIME_ORIGIN = prior;
  }
});

test("non-local, credential-bearing or ambiguous origins fail without leaking input", () => {
  for (const value of ["", "not-a-url", "https://127.0.0.1:8721", "http://example.com", "http://127.0.0.1.example.com",
    "http://private:secret@127.0.0.1:8721", "http://127.0.0.1:8721/api", "http://127.0.0.1:8721/?secret=value",
    "http://127.0.0.1:8721/#private", "http://127.0.0.1:99999"]) {
    assert.throws(() => probeRuntimeOrigin(value), /^Error: invalid_probe_runtime_origin$/);
  }
});

test("both runners share routing and fingerprint the helper without changing sample guards", () => {
  for (const name of ["run.mjs", "protected-authoring-run.mjs"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.ok(source.includes('import { probeRuntimeOrigin } from "./probe-runtime.mjs"'));
    assert.ok(source.includes('"probe-runtime.mjs"'));
    assert.ok(source.includes('target: runtimeOrigin'));
    assert.ok(source.includes('runtimeOrigin + "/api"'));
    assert.ok(!source.includes('target: "http://127.0.0.1:8719"'));
  }
  const baseline = readFileSync(new URL("run.mjs", import.meta.url), "utf8");
  assert.ok(baseline.includes("samples !== 21"));
  assert.ok(baseline.includes("guardMs > 300000"));
});
