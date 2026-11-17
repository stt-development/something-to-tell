import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { NarrativeNodeRenderData } from "./app/workspaceShared";
import * as graphPresentation from "./app/graph/graphProjection";
import * as topologyBatch from "./app/graph/nodeTopologyMetrics";
import * as frameMembership from "./app/graph/frameMembershipSignatures";
import * as frameCounts from "./app/graph/frameContentCounts";
import * as dialoguePresentation from "./dialogue/presentation";
import { applyProjectLocale } from "./localization/i18n";
import * as questPresentation from "./quest/presentation";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const boundary = vi.hoisted(() => ({ samples: [] as ReactFlowProps[] }));
// Delegate to real React Flow; this probe observes presentation inputs, not render commits.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    boundary.samples.push(props);
    return <actual.ReactFlow {...props} />;
  } };
});
beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  boundary.samples.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const latest = () => boundary.samples.at(-1)!.nodes as Node<NarrativeNodeRenderData>[];
const node = (id: string) => latest().find((item) => item.id === id)!;
const keys = ["questMetrics", "dialogueMetrics", "frameContentCounts", "presentationMetrics", "factionMembers", "outcomeTargets", "sceneBoundarySummary", "flowCalls", "flowExits", "flowRole"] as const;

/** Serialize only these small presentation values; call functions are audited separately. */
function inventory(before: Node<NarrativeNodeRenderData>[]) {
  const previous = new Map(before.map((item) => [item.id, item]));
  return Object.fromEntries(keys.map((key) => {
    const values = latest().flatMap((item) => {
      const old = previous.get(item.id)?.data[key];
      const next = item.data[key];
      return old !== undefined && next !== undefined ? [{ old, next }] : [];
    });
    return [key, { present: values.length, replaced: values.filter(({ old, next }) => old !== next).length,
      changed: values.filter(({ old, next }) => JSON.stringify(old) !== JSON.stringify(next)).length }];
  }));
}

it.each(["selection", "unrelated Text"])("classifies per-field inputs and work after %s", (change) => {
  const quest = vi.spyOn(questPresentation, "questCanvasMetrics");
  const dialogue = vi.spyOn(dialoguePresentation, "dialogueCanvasMetrics");
  const frames = vi.spyOn(frameCounts, "countFrameChildren");
  const countInputs = vi.spyOn(frameCounts, "buildFrameCountInputs");
  const topology = vi.spyOn(graphPresentation, "nodePresentationMetrics");
  const batch = vi.spyOn(topologyBatch, "buildNodeTopologyMetrics");
  const signatures = vi.spyOn(frameMembership, "buildFrameMembershipSignatures");
  const members = vi.spyOn(graphPresentation, "factionMembers");
  render(<App />);
  const before = latest();
  const questDocument = node("node-smuggler-route").data.questDocument;
  const dialogueDocument = node("node-dock-dialogue").data.dialogueDocument;
  quest.mockClear(); dialogue.mockClear(); frames.mockClear(); topology.mockClear(); batch.mockClear(); signatures.mockClear(); members.mockClear();
  countInputs.mockClear();
  if (change === "selection") fireEvent.click(screen.getByTestId("rf__node-node-hero"));
  else act(() => {
    const source = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === "node-hero")!;
    useGraphStore.getState().updateNode(source.id, { ...source.data, summary: "Unrelated audit text" });
  });
  expect(node("node-smuggler-route").data.questDocument).toBe(questDocument);
  expect(node("node-dock-dialogue").data.dialogueDocument).toBe(dialogueDocument);
  expect(frames).not.toHaveBeenCalled();
  expect(countInputs).not.toHaveBeenCalled();
  expect(signatures).toHaveBeenCalledOnce();
  expect(signatures.mock.calls[0]![0]).toHaveLength(18);
  expect(topology).not.toHaveBeenCalled();
  expect(batch).toHaveBeenCalledOnce();
  expect(members).toHaveBeenCalledTimes(1);
  expect(inventory(before)).toEqual({
    questMetrics: { present: 1, replaced: 0, changed: 0 },
    dialogueMetrics: { present: 1, replaced: 0, changed: 0 },
    frameContentCounts: { present: 3, replaced: 0, changed: 0 },
    presentationMetrics: { present: 18, replaced: 0, changed: 0 },
    factionMembers: { present: 1, replaced: 0, changed: 0 },
    outcomeTargets: { present: 3, replaced: 0, changed: 0 },
    sceneBoundarySummary: { present: 1, replaced: 0, changed: 0 },
    flowCalls: { present: 18, replaced: 0, changed: 0 },
    flowExits: { present: 18, replaced: 0, changed: 0 },
    flowRole: { present: 6, replaced: 0, changed: 0 }
  });
  expect({ quest: quest.mock.calls.length, dialogue: dialogue.mock.calls.length }).toEqual({ quest: 0, dialogue: 0 });
});

it("updates Quest metrics on a document edit without freezing the aggregate", () => {
  render(<App />);
  const quest = node("node-smuggler-route");
  const document = quest.data.questDocument!;
  const rewards = document.reward_node_ids.length ? [] : ["node-sealed-ledger"];
  act(() => useGraphStore.getState().updateQuestDocument(quest.id, { ...document, reward_node_ids: rewards }));
  expect(node(quest.id).data.questMetrics!.rewards).toBe(rewards.length);
  expect(node(quest.id).data.questMetrics).not.toEqual(quest.data.questMetrics);
});

it("shares Quest metrics with a linked placement and updates both through the store", () => {
  const countInputs = vi.spyOn(frameCounts, "buildFrameCountInputs");
  const formatter = vi.spyOn(frameCounts, "countFrameChildren");
  render(<App />);
  const sceneCounts = node("node-opening").data.frameContentCounts!;
  const locationCounts = node("node-harbor").data.frameContentCounts;
  countInputs.mockClear();
  formatter.mockClear();
  act(() => {
    expect(useGraphStore.getState().addLinkedInstance("node-smuggler-route", "node-opening").valid).toBe(true);
  });
  const placements = () => latest().filter((item) => item.data.kind === "Quest");
  expect(node("node-opening").data.frameContentCounts!.total).toBe(sceneCounts.total + 1);
  expect(node("node-opening").data.frameContentCounts!.tooltip).toContain("1 quest");
  expect(node("node-harbor").data.frameContentCounts).toBe(locationCounts);
  expect(countInputs).toHaveBeenCalledOnce();
  expect(countInputs.mock.calls[0]![0]).toHaveLength(19);
  expect(formatter).toHaveBeenCalledOnce();
  expect(formatter.mock.calls[0]![0]).toHaveLength(sceneCounts.total + 1);
  expect(placements()).toHaveLength(2);
  const before = placements()[0]!.data.questMetrics;
  expect(placements()[1]!.data.questMetrics).toBe(before);
  const document = placements()[0]!.data.questDocument!;
  act(() => useGraphStore.getState().updateQuestDocument(placements()[1]!.id, { ...document, reward_node_ids: [] }));
  expect(placements()[0]!.data.questMetrics).not.toBe(before);
  expect(placements()[1]!.data.questMetrics).toBe(placements()[0]!.data.questMetrics);
  expect(placements()[0]!.data.questMetrics!.rewards).toBe(0);
});

it("refreshes direct-child type tooltips and retains raw counts after collapsing the Scene", () => {
  render(<App />);
  const before = node("node-opening").data.frameContentCounts!;
  const child = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.parentId === "node-opening" && item.data.kind === "Lore")!;
  act(() => useGraphStore.getState().updateNode(child.id, { ...child.data, kind: "Event" }));
  const changed = node("node-opening").data.frameContentCounts!;
  expect(changed.total).toBe(before.total);
  expect(changed.tooltip).toContain("2 events");
  expect(changed.tooltip).not.toContain("lore");
  expect(changed).not.toBe(before);
  act(() => useGraphStore.getState().toggleFrameCollapse("node-opening"));
  expect(latest().find((item) => item.id === child.id)).toBeUndefined();
  expect(node("node-opening").data.frameContentCounts).toBe(changed);
});

it("updates Dialogue endings on an external-origin edit even with the same document", () => {
  render(<App />);
  const dialogue = node("node-dock-dialogue");
  act(() => useGraphStore.getState().deleteEdge("edge-dialogue-blockade"));
  expect(node(dialogue.id).data.dialogueDocument).toBe(dialogue.data.dialogueDocument);
  expect(node(dialogue.id).data.dialogueMetrics!.endings).toBe(dialogue.data.dialogueMetrics!.endings + 1);
});

it("updates Dialogue document metrics while unrelated edge deletion retains the numeric result", () => {
  render(<App />);
  const before = node("node-dock-dialogue");
  act(() => useGraphStore.getState().deleteEdge("edge-guild-ledger"));
  expect(node(before.id).data.dialogueMetrics).toBe(before.data.dialogueMetrics);
  const source = before.data.dialogueDocument!;
  act(() => useGraphStore.getState().updateDialogueDocument(before.id, { ...source, elements: [...source.elements,
    { id: "audit-line", kind: "line", text: "Another ending", speaker_node_id: source.participants[0]!, next_element_id: null }
  ] }));
  expect(node(before.id).data.dialogueMetrics!.lines).toBe(before.data.dialogueMetrics!.lines + 1);
  expect(node(before.id).data.dialogueMetrics).not.toBe(before.data.dialogueMetrics);
});

it.each([
  { owner: "node-trade-guild", target: "node-hero", field: "factionMembers" },
  { owner: "node-route-consequence", target: "node-smuggler-route", field: "outcomeTargets" },
  { owner: "node-opening", target: "node-dock-dialogue", field: "sceneBoundarySummary" }
] as const)("updates $field when a referenced target is renamed", ({ owner, target, field }) => {
  render(<App />);
  const source = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === target)!;
  act(() => useGraphStore.getState().updateNode(source.id, { ...source.data, title: "Updated metric target" }));
  if (field === "sceneBoundarySummary") expect(node(owner).data.sceneBoundarySummary!.entry).toBe("Updated metric target");
  else expect(node(owner).data[field]).toContain("Updated metric target");
});

it("keeps topology and child counts based on the raw graph rather than the Flow projection", () => {
  render(<App />);
  const before = new Map(latest().map((item) => [item.id, item.data.presentationMetrics]));
  const children = node("node-opening").data.frameContentCounts;
  const rawGraph = useGraphStore.getState().getActiveGraph();
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(latest().length).toBeLessThan(rawGraph.nodes.length);
  for (const item of latest().filter((item) => before.has(item.id))) expect(item.data.presentationMetrics).toBe(before.get(item.id));
  expect(node("node-opening").data.frameContentCounts).toBe(children);
});

it("refreshes canonical metrics for a hidden semantic edge while retaining unrelated values", () => {
  render(<App />);
  const membership = useGraphStore.getState().getActiveGraph().edges.find((item) => item.source === "node-hero" && item.data?.relationshipType === "member_of")!;
  expect(membership).toBeDefined();
  expect(boundary.samples.at(-1)!.edges!.some((item) => item.id === membership.id)).toBe(false);
  const before = node("node-hero").data.presentationMetrics!;
  const unrelated = node("node-smuggler-route").data.presentationMetrics;
  act(() => useGraphStore.getState().deleteEdge(membership.id));
  const after = node("node-hero").data.presentationMetrics!;
  expect(after.outgoing).toBe(before.outgoing - 1);
  expect(after).not.toBe(before);
  expect(node("node-smuggler-route").data.presentationMetrics).toBe(unrelated);
  for (const item of latest().filter((item) => (item.data.canonicalNodeId ?? item.id) === "node-hero")) {
    expect(item.data.presentationMetrics).toBe(after);
  }
});

it("refreshes the Faction title list through existing membership commands", () => {
  render(<App />);
  const before = node("node-trade-guild").data.factionMembers;
  expect(before).toEqual(["Mara Vale"]);
  act(() => { expect(useGraphStore.getState().addFactionMember("node-trade-guild", "node-dockmaster").valid).toBe(true); });
  expect(node("node-trade-guild").data.factionMembers).toEqual(["Ilya Voss", "Mara Vale"]);
  expect(node("node-trade-guild").data.factionMembers).not.toBe(before);
  act(() => { expect(useGraphStore.getState().removeFactionMember("node-trade-guild", "node-hero").valid).toBe(true); });
  expect(node("node-trade-guild").data.factionMembers).toEqual(["Ilya Voss"]);
});

it("refreshes ordered outcome targets without freezing the independent effect text", () => {
  render(<App />);
  const source = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === "node-route-consequence")!;
  const before = node(source.id).data.outcomeTargets;
  const outcome = { effect: "Reordered targets", targetNodeIds: ["node-harbor", "node-smuggler-route"] };
  act(() => useGraphStore.getState().updateNode(source.id, { ...source.data, outcome }));
  const after = node(source.id).data.outcomeTargets;
  expect(after).toEqual(["Glass Harbor", "Smuggler Route"]);
  expect(after).not.toBe(before);
  act(() => useGraphStore.getState().updateNode(source.id, { ...source.data, outcome: { ...outcome, effect: "Changed effect only" } }));
  expect(node(source.id).data.outcomeTargets).toBe(after);
  expect(node(source.id).data.outcome!.effect).toBe("Changed effect only");
});

it("refreshes and removes Scene boundary summaries without replacing existing configuration actions", () => {
  render(<App />);
  const state = useGraphStore.getState();
  const flows = state.storyFlowsByProject[state.activeProjectId]!;
  const main = flows.find((item) => item.flow.id === "flow-main-story")!;
  const boundary = main.scene_boundaries.find((item) => item.scene_node_id === "node-opening")!;
  const before = node("node-opening").data.sceneBoundarySummary;
  const configure = node("node-opening").data.onConfigureSceneBoundary;
  const replace = (scene_boundaries: typeof main.scene_boundaries) => act(() => useGraphStore.setState({
    storyFlowsByProject: { ...state.storyFlowsByProject, [state.activeProjectId]: flows.map((item) => item.flow.id === main.flow.id ? { ...item, scene_boundaries } : item) }
  }));
  replace([{ ...boundary, entry_node_id: "node-sealed-ledger", exit_node_ids: [] }]);
  expect(node("node-opening").data.sceneBoundarySummary).toEqual({ entry: "Sealed Ledger", exits: 0 });
  expect(node("node-opening").data.onConfigureSceneBoundary).toBe(configure);
  replace([]);
  expect(node("node-opening").data.sceneBoundarySummary).toBeUndefined();
  replace([boundary]);
  expect(node("node-opening").data.sceneBoundarySummary).toEqual(before);
  expect(node("node-opening").data.sceneBoundarySummary).not.toBe(before);
  expect(node("node-opening").data.onConfigureSceneBoundary).toBe(configure);
});

it("updates exit rows and label/key fallback across canonical linked placements", () => {
  const state = useGraphStore.getState();
  const flows = state.storyFlowsByProject[state.activeProjectId]!;
  const main = flows.find((item) => item.flow.id === "flow-main-story")!;
  const template = flows.flatMap((item) => item.exits ?? [])[0]!;
  const exit = { ...template, id: "audit-exit", project_id: state.activeProjectId, flow_id: main.flow.id,
    source_node_id: "node-sealed-ledger", key: "departure", label: "Reviewed departure" };
  const replace = (exits: NonNullable<typeof main.exits>) => act(() => useGraphStore.setState({
    storyFlowsByProject: { ...state.storyFlowsByProject, [state.activeProjectId]: flows.map((item) => item.flow.id === main.flow.id ? { ...item, exits } : item) }
  }));
  replace([exit]);
  render(<App />);
  const before = node("node-sealed-ledger").data.flowExits!;
  const createExit = node("node-sealed-ledger").data.onCreateFlowExit;
  replace([{ ...exit, key: "renamed_exit", label: "" }]);
  const changed = node("node-sealed-ledger").data.flowExits!;
  expect(changed).toEqual([{ id: exit.id, key: "renamed_exit", label: "" }]);
  expect(changed[0]).not.toBe(before[0]);
  expect(before[0]!.label).toBe("Reviewed departure");
  expect(node("node-sealed-ledger").data.onCreateFlowExit).toBe(createExit);
  for (const item of latest().filter((item) => (item.data.canonicalNodeId ?? item.id) === "node-sealed-ledger")) expect(item.data.flowExits).toBe(changed);
  expect(screen.getByTestId("rf__node-node-sealed-ledger").querySelector(".flow-exit-status")).toHaveTextContent("renamed_exit");
  replace([]);
  expect(node("node-sealed-ledger").data.flowExits).toEqual([]);
  expect(screen.getByTestId("rf__node-node-sealed-ledger").querySelector(".flow-exit-status")).toBeNull();
});
