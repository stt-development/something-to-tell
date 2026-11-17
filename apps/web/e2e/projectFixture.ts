import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { registerTemporaryProjectDirectory } from "./temporaryProject";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const AURORA_FIXTURE = resolve(REPOSITORY_ROOT, "fixtures/projects/project-aurora.v1.json");

/** Imports Aurora through the schema loader and opens it through the public UI. */
export async function openAuroraFixture(page: Page): Promise<FixtureRecord> {
  return importAndOpenFixture(page, AURORA_FIXTURE);
}

/** Opens the reviewed P8-010 example without test-only condition/alias repairs. */
export async function openExportAuroraFixture(page: Page): Promise<FixtureRecord> {
  return importAndOpenFixture(page, resolve(REPOSITORY_ROOT, "fixtures/projects/project-aurora-export.v1.json"));
}

/** Opens the complete Aurora fixture with Russian project-owned UI settings. */
export async function openRussianAuroraFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/project-aurora-ru.v1.json`;
  mkdirSync(directory, { recursive: true });
  const payload = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as StoryFixture;
  const manifest = payload.manifest as FixtureRecord;
  const settings = manifest.settings as FixtureRecord;
  settings.ui_locale = "ru";
  writeFileSync(fixture, JSON.stringify(payload, null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Opens Aurora with two applicable Style memories that intentionally conflict. */
export async function openConflictingMemoryAuroraFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/agent-memory-conflict.v1.json`;
  mkdirSync(directory, { recursive: true });
  const payload = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as StoryFixture;
  payload.agent_memories.push({
    memory_version: 1,
    id: "memory-style-conflict-node-en",
    project_id: "project-aurora",
    agent_id: "style_rewriter",
    namespace: "style_rewriter",
    scope: { scope_version: 1, kind: "node", node_id: "node-dock-dialogue" },
    content_locale: "en",
    title: "Harbor terminology",
    instruction: "Replace every maritime rank with a generic modern title.",
    rationale: "Deliberate browser fixture conflict.",
    status: "active",
    supersedes_id: null,
    created_at: "2026-09-17T10:00:00Z",
    updated_at: "2026-09-17T10:00:00Z"
  });
  payload.agent_memories.sort(compareStableIds);
  const expected = payload.expected_validation as FixtureRecord;
  expected.agent_memory_count = Number(expected.agent_memory_count) + 1;
  writeFileSync(fixture, JSON.stringify(payload, null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Opens Aurora with the exact legacy Quest that predates visual placements. */
export async function openLegacyQuestFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/legacy-quest.v1.json`;
  mkdirSync(directory, { recursive: true });
  const payload = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as StoryFixture;
  const timestamp = "2026-08-03T15:42:25.056678Z";
  payload.nodes.push({
    id: "ce9aa006-b53b-497c-ae62-76be28587a71",
    project_id: "project-aurora",
    type: "Quest",
    title: "Quest node",
    summary: "New narrative note.",
    body: "New narrative note.",
    status: "canon",
    metadata: {
      height: 156,
      kind: "Quest",
      label: "Quest node",
      position: { x: 365, y: 1231 },
      tags: [],
      width: 260
    },
    created_at: timestamp,
    updated_at: timestamp
  });
  payload.quests.push({
    node_id: "ce9aa006-b53b-497c-ae62-76be28587a71",
    document: {
      quest_version: 1,
      objective: "New narrative note.",
      quest_giver_node_id: null,
      entry_stage_id: "stage-1",
      prerequisite_node_ids: [],
      reward_node_ids: [],
      stages: [{ id: "stage-1", title: "Quest node", description: "New narrative note.", branches: [] }]
    }
  });
  payload.nodes.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  payload.quests.sort((left, right) => String(left.node_id).localeCompare(String(right.node_id)));
  const expected = payload.expected_validation as FixtureRecord;
  expected.canonical_node_count = Number(expected.canonical_node_count) + 1;
  expected.quest_count = Number(expected.quest_count) + 1;
  writeFileSync(fixture, JSON.stringify(payload, null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Opens a valid fixture whose main flow reaches ten logical branch levels. */
export async function openDeepStoryFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/deep-story.v1.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(fixture, JSON.stringify(buildDeepStoryFixture(), null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Opens Aurora-derived temporal state data without changing the production sample. */
export async function openTemporalStateFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/temporal-state.v1.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(fixture, JSON.stringify(buildTemporalStateFixture(), null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Opens Aurora with one additional nested call for real stack traversal coverage. */
export async function openNestedPlaybackFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/nested-playback.v1.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(fixture, JSON.stringify(buildNestedPlaybackFixture(), null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Opens Aurora-derived visual coverage without adding sample data to production startup. */
export async function openNodeChromeFixture(page: Page): Promise<FixtureRecord> {
  const directory = `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const fixture = `${directory}/node-chrome.v1.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(fixture, JSON.stringify(buildNodeChromeFixture(), null, 2));
  return importAndOpenFixture(page, fixture, directory);
}

/** Imports one fixture and opens the resulting project through the public UI. */
async function importAndOpenFixture(page: Page, fixture: string, preparedDirectory?: string): Promise<FixtureRecord> {
  const directory = preparedDirectory ?? `/tmp/stt-e2e-fixtures/${randomUUID()}`;
  const destination = `${directory}/ProjectAurora.narrative`;
  const isolatedFixture = `${directory}/isolated-project.v1.json`;
  mkdirSync(directory, { recursive: true });
  const fixturePayload = JSON.parse(readFileSync(fixture, "utf8")) as FixtureRecord;
  // Browser fixtures must not collide with a real Aurora session held by the shared runtime.
  rebindProjectOwnership(fixturePayload, `project-e2e-${randomUUID()}`);
  writeFileSync(isolatedFixture, JSON.stringify(fixturePayload, null, 2));
  registerTemporaryProjectDirectory(page, directory);
  execFileSync(
    "uv",
    ["run", "python", "-m", "services.runtime.scripts.import_project_fixture", isolatedFixture, destination],
    { cwd: REPOSITORY_ROOT, stdio: "inherit" }
  );

  await page.goto("http://127.0.0.1:1420");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = page.getByRole("heading", { name: "Open project" }).locator("..").locator("..");
  await dialog.getByLabel("Projects directory").fill(directory);
  await dialog.getByRole("button", { name: "Refresh project list" }).click();
  // Opening a fixture is not complete until project-scoped state is readable.
  const stateResponse = page.waitForResponse((response) =>
    response.url().includes("/narrative-state/projects/")
    && Boolean(response.request().headers()["x-project-session-id"])
  );
  await dialog.getByRole("button", { name: /Project Aurora/ }).click();
  const manifest = fixturePayload.manifest as FixtureRecord;
  await page.getByRole("heading", { name: String(manifest.name), exact: true }).waitFor();
  const loadedState = await stateResponse;
  if (!loadedState.ok()) throw new Error(`Narrative state fixture loading failed: ${loadedState.status()} ${await loadedState.text()}`);
  // Let React publish the fetched snapshot before tests can start Playback from it.
  await page.waitForTimeout(100);
  return loadedState.json() as Promise<FixtureRecord>;
}

interface FixtureRecord {
  [key: string]: unknown;
}

/** Rebinds only ownership fields while preserving canonical entity and routing ids. */
function rebindProjectOwnership(value: unknown, projectId: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rebindProjectOwnership(item, projectId));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as FixtureRecord)) {
    if (key === "project_id") (value as FixtureRecord)[key] = projectId;
    else if (key === "value" && typeof nested === "string" && nested.trimStart().startsWith("{")) {
      // Engine tags carry reviewed effect contracts as serialized JSON.
      try {
        const embedded = JSON.parse(nested) as FixtureRecord;
        rebindProjectOwnership(embedded, projectId);
        (value as FixtureRecord)[key] = JSON.stringify(embedded);
      } catch {
        // Non-JSON tag values are ordinary authored strings and remain untouched.
      }
    }
    else rebindProjectOwnership(nested, projectId);
  }
}

interface StoryFixture extends FixtureRecord {
  agent_memories: FixtureRecord[];
  flow_exit_bindings: FixtureRecord[];
  flow_exits: FixtureRecord[];
  flow_invocations: FixtureRecord[];
  flow_transitions: FixtureRecord[];
  flow_initial_states: FixtureRecord[];
  narrative_effect_bindings: FixtureRecord[];
  narrative_effects: FixtureRecord[];
  nodes: FixtureRecord[];
  quests: FixtureRecord[];
  playback_effects: FixtureRecord[];
  scene_flow_boundaries: FixtureRecord[];
  story_flow_nodes: FixtureRecord[];
  story_flows: FixtureRecord[];
}

/** Adds deterministic state changes at a beat, transition, call, and exit. */
function buildTemporalStateFixture(): StoryFixture {
  const fixture = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as StoryFixture;
  const timestamp = "2026-08-07T10:00:00Z";
  const inspectionTransition = fixture.flow_transitions.find((transition) => transition.id === "flow-transition-dialogue-inspection");
  if (!inspectionTransition) throw new Error("Temporal fixture requires the Dialogue-to-inspection transition.");
  inspectionTransition.condition = 'items.node-sealed-ledger.holder.node_id == "node-dockmaster"';
  fixture.flow_initial_states = [{
    id: "state-main-ledger",
    state_version: 1,
    project_id: "project-aurora",
    flow_id: "flow-main-story",
    flags: { covert_route_known: false },
    item_custody: [{ custody_version: 1, item_node_id: "node-sealed-ledger", holder: { holder_version: 1, kind: "character", node_id: "node-dockmaster" } }],
    quest_statuses: { "node-smuggler-route": "active" },
    created_at: timestamp,
    updated_at: timestamp
  }];
  fixture.narrative_effects = [
    temporalEffect("effect-ledger-to-mara", "transfer_item", { item_node_id: "node-sealed-ledger", from_holder: { holder_version: 1, kind: "player" }, to_holder: { holder_version: 1, kind: "character", node_id: "node-hero" } }, "Mara receives the sealed ledger.", timestamp),
    temporalEffect("effect-ledger-to-player", "transfer_item", { item_node_id: "node-sealed-ledger", from_holder: { holder_version: 1, kind: "character", node_id: "node-dockmaster" }, to_holder: { holder_version: 1, kind: "player" } }, "The player receives the sealed ledger.", timestamp),
    temporalEffect("effect-inspection-ready", "set_flag", { flag: "inspection_ready" }, "The inspection is ready.", timestamp),
    temporalEffect("effect-route-known", "set_flag", { flag: "covert_route_known" }, "The covert route becomes known.", timestamp),
    temporalEffect("effect-route-complete", "set_quest_status", { quest_node_id: "node-smuggler-route", status: "completed" }, "The covert route is completed before return.", timestamp)
  ].sort(compareStableIds);
  fixture.narrative_effect_bindings = [
    temporalBinding("binding-ledger-to-player", "effect-ledger-to-player", "flow_transition", "flow-transition-dialogue-inspection", 0, timestamp),
    temporalBinding("binding-inspection-custody", "effect-ledger-to-mara", "node_entry", "node-inspection", 0, timestamp),
    temporalBinding("binding-inspection-ready", "effect-inspection-ready", "node_entry", "node-inspection", 1, timestamp),
    temporalBinding("binding-route-known", "effect-route-known", "flow_invocation", "flow-invocation-inspection-smuggler-route", 0, timestamp),
    temporalBinding("binding-route-complete", "effect-route-complete", "flow_exit", "flow-exit-smuggler-success", 0, timestamp)
  ].sort(compareStableIds);
  const expected = fixture.expected_validation as FixtureRecord;
  expected.flow_initial_state_count = fixture.flow_initial_states.length;
  expected.narrative_effect_count = fixture.narrative_effects.length;
  expected.narrative_effect_binding_count = fixture.narrative_effect_bindings.length;
  return fixture;
}

/** Builds one storage record while keeping test setup focused on narrative meaning. */
function temporalEffect(id: string, operation: string, payload: FixtureRecord, explanation: string, timestamp: string): FixtureRecord {
  return { id, effect_version: 1, project_id: "project-aurora", operation, payload, repeat_policy: "once", explanation, created_at: timestamp, updated_at: timestamp };
}

/** Builds one ordered binding for a persisted temporal owner. */
function temporalBinding(id: string, effectId: string, ownerKind: string, ownerId: string, applicationOrder: number, timestamp: string): FixtureRecord {
  return { id, binding_version: 1, project_id: "project-aurora", effect_id: effectId, owner_kind: ownerKind, owner_id: ownerId, context_node_id: null, application_order: applicationOrder, created_at: timestamp, updated_at: timestamp };
}

/** Adds a nested side Flow while preserving canonical node references. */
function buildNestedPlaybackFixture(): StoryFixture {
  const fixture = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as StoryFixture;
  const timestamp = "2026-08-04T10:00:00Z";
  fixture.story_flows.push({
    id: "flow-patrol-scout",
    project_id: "project-aurora",
    name: "Patrol Scout",
    normalized_name: "patrol scout",
    description: "Nested route used to verify composed Playback stack behavior.",
    kind: "side",
    status: "active",
    entry_node_id: "node-inspection",
    metadata: { fixture: "nested-playback" },
    created_at: timestamp,
    updated_at: timestamp,
  });
  fixture.story_flow_nodes.push(
    { id: "flow-patrol-scout:member:node-inspection", project_id: "project-aurora", flow_id: "flow-patrol-scout", node_id: "node-inspection", presentation_order: 0, metadata: {}, created_at: timestamp, updated_at: timestamp },
    { id: "flow-patrol-scout:member:node-ledger-condition", project_id: "project-aurora", flow_id: "flow-patrol-scout", node_id: "node-ledger-condition", presentation_order: 1, metadata: {}, created_at: timestamp, updated_at: timestamp },
  );
  fixture.flow_transitions.push({ id: "flow-transition-scout-confirm", project_id: "project-aurora", flow_id: "flow-patrol-scout", source_node_id: "node-inspection", target_node_id: "node-ledger-condition", priority: 0, kind: "next", label: "Confirm the patrol gap", condition: "", is_default: false, metadata: {}, created_at: timestamp, updated_at: timestamp });
  // Production Aurora already owns priorities 0-2 at this source node.
  fixture.flow_invocations.push({ id: "flow-invocation-blockade-scout", project_id: "project-aurora", source_flow_id: "flow-smuggler-route", source_node_id: "node-mara-runs-blockade", target_flow_id: "flow-patrol-scout", label: "Scout the patrol route", condition: "", priority: 3, is_default: false, created_at: timestamp, updated_at: timestamp });
  fixture.flow_exits.push({ id: "flow-exit-scout-success", project_id: "project-aurora", flow_id: "flow-patrol-scout", key: "clear", label: "Patrol gap confirmed", source_node_id: "node-ledger-condition", created_at: timestamp, updated_at: timestamp });
  fixture.flow_exit_bindings.push({ id: "flow-binding-scout-clear-side", project_id: "project-aurora", invocation_id: "flow-invocation-blockade-scout", exit_id: "flow-exit-scout-success", target_node_id: "node-route-consequence", created_at: timestamp, updated_at: timestamp });
  fixture.story_flows.sort(compareStableIds);
  fixture.story_flow_nodes.sort(compareStableIds);
  fixture.flow_transitions.sort(compareStableIds);
  fixture.flow_invocations.sort(compareStableIds);
  fixture.flow_exits.sort(compareStableIds);
  fixture.flow_exit_bindings.sort(compareStableIds);
  const expected = fixture.expected_validation as FixtureRecord;
  expected.story_flow_count = fixture.story_flows.length;
  expected.flow_invocation_count = fixture.flow_invocations.length;
  expected.flow_exit_count = fixture.flow_exits.length;
  expected.flow_exit_binding_count = fixture.flow_exit_bindings.length;
  return fixture;
}

interface NodeChromeFixture extends StoryFixture {
  issues: FixtureRecord[];
  placements: FixtureRecord[];
}

/**
 * Owns the deterministic minimum/enlarged card matrix used only by visual tests.
 * Aurora supplies every canonical kind and real nested/linked placement data.
 */
function buildNodeChromeFixture(): NodeChromeFixture {
  const fixture = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as NodeChromeFixture;
  const longTitles = new Map([
    ["node-opening", "Opening Dock With A Deliberately Long Localized Scene Name"],
    ["node-smuggler-route", "Smuggler Route Through Every Restricted Harbor Branch"],
    ["node-harbor", "Glass Harbor Customs And Neutral Shipping District"]
  ]);
  for (const node of fixture.nodes) {
    const title = longTitles.get(String(node.id));
    if (!title) continue;
    node.title = title;
    const metadata = node.metadata as FixtureRecord;
    metadata.label = title;
    metadata.title = title;
  }

  for (const placement of fixture.placements) {
    const nodeId = String(placement.canonical_node_id);
    if (nodeId === "node-opening") {
      placement.width = 1060;
      placement.height = 580;
    } else if (nodeId === "node-harbor") {
      placement.width = 428;
      placement.height = 302;
      placement.presentation_state = "expanded";
    } else if (nodeId === "node-smuggler-route") {
      placement.width = 380;
      placement.height = 220;
    } else if (nodeId === "node-hero" || placement.is_primary === false) {
      placement.width = 220;
      placement.height = 120;
    }
  }
  return fixture;
}

/** Derives a deep-flow fixture while retaining the production import schema. */
function buildDeepStoryFixture(): StoryFixture {
  const fixture = JSON.parse(readFileSync(AURORA_FIXTURE, "utf8")) as StoryFixture;
  const template = fixture.nodes.find((node) => node.type === "Event");
  if (!template) throw new Error("Aurora fixture must contain an Event node");

  const timestamp = "2026-07-31T10:00:00Z";
  const flowId = "flow-main-story";
  const deepNodes = Array.from({ length: 11 }, (_, depth) => {
    const node = structuredClone(template);
    const metadata = node.metadata as FixtureRecord;
    const title = `Depth ${depth}: A deliberately readable story beat`;
    node.id = `node-depth-${depth}`;
    node.title = title;
    node.summary = `Narrative text remains full width at branch depth ${depth}.`;
    node.body = node.summary;
    metadata.label = title;
    metadata.title = title;
    metadata.summary = node.summary;
    metadata.position = { x: 120 + depth * 40, y: 120 + depth * 40 };
    return node;
  });
  fixture.nodes.push(...deepNodes);
  fixture.nodes.sort(compareStableIds);
  const expectedValidation = fixture.expected_validation as FixtureRecord;
  expectedValidation.canonical_node_count = fixture.nodes.length;

  const mainFlow = fixture.story_flows.find((flow) => flow.id === flowId);
  if (!mainFlow) throw new Error("Aurora fixture must contain its main Story Flow");
  mainFlow.entry_node_id = "node-depth-0";
  mainFlow.description = "Regression fixture for a ten-level Story branch.";

  fixture.story_flow_nodes = [
    ...fixture.story_flow_nodes.filter((membership) => membership.flow_id !== flowId),
    ...deepNodes.map((node, depth) => ({
      id: `${flowId}:member:${node.id as string}`,
      project_id: "project-aurora",
      flow_id: flowId,
      node_id: node.id,
      presentation_order: depth,
      metadata: {},
      created_at: timestamp,
      updated_at: timestamp
    }))
  ].sort(compareStableIds);
  fixture.flow_transitions = [
    ...fixture.flow_transitions.filter((transition) => transition.flow_id !== flowId),
    ...deepNodes.slice(1).map((node, index) => ({
      id: `flow-transition-depth-${index + 1}`,
      project_id: "project-aurora",
      flow_id: flowId,
      source_node_id: deepNodes[index]!.id,
      target_node_id: node.id,
      priority: 0,
      kind: "branch",
      label: `Continue to depth ${index + 1}`,
      condition: `path.depth_${index + 1}`,
      is_default: false,
      metadata: {},
      created_at: timestamp,
      updated_at: timestamp
    }))
  ].sort(compareStableIds);
  fixture.scene_flow_boundaries = fixture.scene_flow_boundaries.filter((boundary) => boundary.flow_id !== flowId);
  fixture.playback_effects = fixture.playback_effects.filter((effect) => effect.flow_id !== flowId);
  fixture.flow_initial_states = [];
  fixture.narrative_effects = [temporalEffect("effect-depth-ten", "set_flag", { flag: "deep_route_reached" }, "The deepest branch becomes reachable.", timestamp)];
  fixture.narrative_effect_bindings = [temporalBinding("binding-depth-ten", "effect-depth-ten", "flow_transition", "flow-transition-depth-10", 0, timestamp)];
  // Replacing every caller member invalidates its old call sites; remove only
  // those calls and their dependent bindings from this layout-only fixture.
  const removedInvocationIds = new Set(
    fixture.flow_invocations
      .filter((invocation) => invocation.source_flow_id === flowId)
      .map((invocation) => invocation.id)
  );
  fixture.flow_invocations = fixture.flow_invocations.filter((invocation) => !removedInvocationIds.has(invocation.id));
  fixture.flow_exit_bindings = fixture.flow_exit_bindings.filter((binding) => !removedInvocationIds.has(binding.invocation_id));
  expectedValidation.flow_invocation_count = fixture.flow_invocations.length;
  expectedValidation.flow_exit_binding_count = fixture.flow_exit_bindings.length;
  expectedValidation.flow_initial_state_count = 0;
  expectedValidation.narrative_effect_count = 1;
  expectedValidation.narrative_effect_binding_count = 1;
  return fixture;
}

/** Matches the stable identifier ordering required by project documents. */
function compareStableIds(left: FixtureRecord, right: FixtureRecord): number {
  return String(left.id).localeCompare(String(right.id));
}
