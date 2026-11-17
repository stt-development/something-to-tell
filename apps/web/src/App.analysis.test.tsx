import {
createDefaultProjectSettings,
PROJECT_SETTINGS_VERSION
} from "@something-to-tell/contracts/project-manifest";
import { act,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import {
App,
applyIssueOverlays,
applySelectionHighlights,
buildAnalysisPreviewMaps,
buildGraphAnalysisText,
buildLocalSceneAnalysisPreview,
buildRelationshipInspection,
calculateFrameBounds,
createLinkedInstanceFromDrop,
CurrentProjectPanel,
DialogueEditorDialog,
displayNodeKind,
EditEdgeDialog,
filterGraphForView,
filterIssuesForView,
getNodeNeighborhood,
hideDirectFrameChildEdges,
hideSemanticEdges,
nodeForWorkspaceFocus,
OutcomeFlowDialog,
ProgressionMigrationDialog,
SceneFlowBoundaryDialog,
withoutDoubleAppliedDescendantMoves
} from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import * as workspaceState from "./app/shell/useWorkspaceState";
import { projectProgressionMigrationReview,rejectProgressionCandidateLocally } from "./story-flow/progressionMigration";
import { createProjectFixtureRuntimeFetch,loadProjectFixturesForTests,projectFixture } from "./testFixtures/projectFixtures";
import { NARRATIVE_NODE_KINDS } from "./types";

const PROJECT_AURORA_STORY_FLOWS = projectFixture("aurora").storyFlows;

describe("App editors, analysis, and projections", () => {
beforeEach(async () => {
    window.localStorage.clear();
    await applyProjectLocale("en");
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
    vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

it("adds and removes a linked instance through the frame title menu", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Add linked node to Opening Dock" }));
    const dialog = screen.getByRole("heading", { name: "Add linked node to Opening Dock" }).closest("section")!;
    fireEvent.click(within(dialog).getByRole("button", { name: /Mara Vale/ }));

    const linked = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.data.isLinkedInstance && node.data.canonicalNodeId === "node-hero")!;
    expect(linked.parentId).toBe("node-opening");
    expect(within(screen.getByTestId(`rf__node-${linked.id}`)).getByLabelText("Linked visual instance")).toHaveAttribute("data-tooltip", "Linked visual instance");

    fireEvent.keyDown(window, { key: "Delete" });
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === linked.id)).toBe(false);
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === "node-hero")).toBe(true);
  });

it("selects only the clicked visual placement of a linked node", () => {
    useGraphStore.getState().addLinkedInstance("node-hero", "node-opening");
    const linked = useGraphStore.getState().getActiveGraph().nodes.find((node) =>
      node.data.isLinkedInstance && node.data.canonicalNodeId === "node-hero"
    )!;
    render(<App />);

    fireEvent.click(screen.getByTestId(`rf__node-${linked.id}`));

    expect(screen.getByTestId(`rf__node-${linked.id}`)).toHaveClass("selected");
    expect(screen.getByTestId("rf__node-node-hero")).not.toHaveClass("selected");
  });

it("adds nodes to the canvas selection with Shift and clears the set with Escape", () => {
    render(<App />);
    const hero = screen.getByTestId("rf__node-node-hero");
    const faction = screen.getByTestId("rf__node-node-trade-guild");

    fireEvent.click(hero);
    // React Flow tracks the real modifier key independently of MouseEvent.shiftKey.
    fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft" });
    fireEvent.click(faction, { shiftKey: true });

    expect(hero).toHaveClass("selected");
    expect(faction).toHaveClass("selected");
    fireEvent.click(faction, { shiftKey: true });
    expect(hero).toHaveClass("selected");
    expect(faction).not.toHaveClass("selected");
    fireEvent.click(faction, { shiftKey: true });
    fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(hero).not.toHaveClass("selected");
    expect(faction).not.toHaveClass("selected");
  });

it("uses Hand mode exclusively for canvas panning", () => {
    render(<App />);
    const hero = screen.getByTestId("rf__node-node-hero");
    const pan = screen.getByRole("button", { name: "Pan canvas" });

    fireEvent.click(hero);
    expect(hero).toHaveClass("selected");
    fireEvent.click(pan);

    expect(pan).toHaveClass("tool-button-active");
    expect(document.querySelector(".react-flow")).toHaveClass("pan-canvas");
    expect(hero).not.toHaveClass("selected");
    fireEvent.click(hero);
    expect(hero).not.toHaveClass("selected");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(document.querySelector(".react-flow")).not.toHaveClass("pan-canvas");
  });

it("reviews a multi-node selection before group deletion", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("rf__node-node-hero"));
    fireEvent.click(screen.getByTestId("rf__node-node-trade-guild"), { shiftKey: true });

    fireEvent.keyDown(window, { key: "Delete" });

    const dialog = screen.getByRole("heading", { name: "Delete selected elements" }).closest("section")!;
    expect(dialog).toHaveTextContent("Mara Vale");
    expect(dialog).toHaveTextContent("Trade Guild");
    fireEvent.click(within(dialog).getByRole("button", { name: "Analyze impact" }));
    const impact = screen.getByRole("complementary", { name: "Impact analysis" });
    expect(impact).toHaveTextContent("Mara Vale");
    expect(impact).toHaveTextContent("Trade Guild");
    expect(within(impact).getByRole("button", { name: "Delete" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(impact).getByRole("button", { name: "Close" }));
    const restored = screen.getByRole("heading", { name: "Delete selected elements" }).closest("section")!;
    await waitFor(() => expect(within(restored).getByRole("button", { name: "Analyze impact" })).toHaveFocus());
    fireEvent.click(within(restored).getByRole("button", { name: "Cancel" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === "node-hero")).toBe(true);
  });

it("copies a canonical project-tree drag payload into its smallest containing frame", () => {
    render(<App />);
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => { values.set(type, value); }
    } as unknown as DataTransfer;

    fireEvent.dragStart(screen.getByRole("button", { name: "Character: Mara Vale" }), { dataTransfer });
    const store = useGraphStore.getState();
    createLinkedInstanceFromDrop(dataTransfer, { x: 500, y: 100 }, store.getActiveGraph().nodes, store.addLinkedInstance);

    expect(values.get("application/x-stt-canonical-node")).toBe("node-hero");
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) =>
      node.data.isLinkedInstance && node.data.canonicalNodeId === "node-hero" && node.parentId === "node-opening"
    )).toBe(true);
  });

it("presents canonical deletion impact instead of silently removing every placement", () => {
    useGraphStore.getState().addLinkedInstance("node-hero", "node-opening");
    render(<App />);
    fireEvent.click(screen.getByTestId("rf__node-node-hero"));

    fireEvent.keyDown(window, { key: "Backspace" });

    const dialog = screen.getByRole("heading", { name: "Delete Mara Vale" }).closest("section")!;
    expect(dialog).toHaveTextContent("2 visual placement(s)");
    expect(dialog).toHaveTextContent("remove only one linked instance");
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === "node-hero")).toBe(true);
  });

it("calculates zoom-independent flow bounds in either drag direction", () => {
    expect(calculateFrameBounds({ x: 620, y: 440 }, { x: 220, y: 140 })).toEqual({
      position: { x: 220, y: 140 },
      size: { width: 400, height: 300 }
    });
  });

it("applies a group drag delta only to the selected ancestor placement", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const changes = [
      { id: "node-opening", type: "position" as const, position: { x: 100, y: 100 }, dragging: true },
      { id: "node-dock-dialogue", type: "position" as const, position: { x: 80, y: 80 }, dragging: true },
      { id: "node-hero", type: "position" as const, position: { x: 900, y: 300 }, dragging: true }
    ];

    expect(withoutDoubleAppliedDescendantMoves(changes, graph.nodes, ["node-opening", "node-dock-dialogue", "node-hero"])).toEqual([
      changes[0],
      changes[2]
    ]);
  });

it("hides direct frame-child arrows while retaining unrelated graph edges", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const canvasEdges = hideDirectFrameChildEdges(graph.nodes, graph.edges);

    expect(canvasEdges.some((edge) => edge.id === "edge-opening-embargo")).toBe(false);
    expect(canvasEdges.some((edge) => edge.id === "edge-opening-harbor")).toBe(false);
    expect(canvasEdges.some((edge) => edge.id === "edge-harbor-dialogue")).toBe(true);
    expect(graph.edges).toHaveLength(11);
    expect(hideSemanticEdges(graph.edges)).toHaveLength(10);
  });

it("opens the dedicated dialogue editor and adds a searched project character", () => {
    useGraphStore.getState().addManualNode({
      title: "Quartermaster Nessa",
      kind: "Character",
      summary: "Harbor authority",
      tags: ["harbor"]
    });
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;
    expect(within(dialog).queryByRole("heading", { name: "Edit node" })).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Search characters"), { target: { value: "Nessa" } });
    const character = within(dialog).getByRole("button", { name: /Quartermaster Nessa/ });
    expect(character).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(character);
    expect(character).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save dialogue" }));

    expect(
      useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-dock-dialogue")?.data.dialogueDocument?.participants
    ).toContain(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.data.title === "Quartermaster Nessa")?.id);
  });

it("edits Dialogue node Text separately from its branching document", () => {
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;
    const nodeText = within(dialog).getByRole("textbox", { name: "Dialogue node Text" });
    fireEvent.change(nodeText, { target: { value: "A revised framing for the guarded exchange." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save: Dialogue node Text" }));

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-dock-dialogue")?.data.summary)
      .toBe("A revised framing for the guarded exchange.");
    expect(within(dialog).getByRole("button", { name: "Save: Dialogue node Text" })).toBeDisabled();
  });

it("renders analysis issue cards under their exact Dialogue branches", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const dialogue = graph.nodes.find((node) => node.id === "node-dock-dialogue")!;
    const branchIssue = {
      id: "dialogue-answer-issue",
      projectId: "project-aurora",
      nodeId: dialogue.id,
      title: "Answer has no continuation",
      description: "Choose a next element or add an outcome.",
      dialogueOwnerIds: ["answer-show-ledger"],
      severity: "critical" as const,
      status: "open" as const
    };
    const { container } = render(
      <DialogueEditorDialog
        canonTargetId="answer-show-ledger"
        characters={graph.nodes.filter((node) => node.data.kind === "Character")}
        document={dialogue.data.dialogueDocument!}
        issues={[branchIssue]}
        node={dialogue}
        nodes={graph.nodes}
        onClose={vi.fn()}
        onCreateTransition={vi.fn()}
        onDeleteTransition={vi.fn()}
        onSave={vi.fn()}
        onSaveNodeText={vi.fn()}
        onUpdateTransition={vi.fn()}
        transitions={graph.edges.filter((edge) => edge.source === dialogue.id)}
      />
    );

    const target = container.querySelector<HTMLElement>('[data-canon-issue-target="true"]');
    expect(target).toHaveAttribute("data-canon-owner-id", "answer-show-ledger");
    expect(within(target!).getByText("Canon issue")).toBeInTheDocument();
    const issueDetails = within(target!).getByLabelText("Issue details");
    expect(issueDetails).toHaveTextContent("Answer has no continuation");
    expect(issueDetails).toHaveTextContent("Choose a next element or add an outcome.");
    expect(target?.closest("article")).not.toHaveAttribute("data-canon-issue-target", "true");
    expect(container.querySelectorAll(".issue-detail-row")).toHaveLength(1);
  });

it("requires used dialogue lines to be resolved before removing a participant", () => {
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;
    expect(within(dialog).getByDisplayValue("How does Mara answer the dockmaster?")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("Cast off. Full power, and keep the inspection boats in our wake.")).toBeInTheDocument();
    const mara = within(dialog).getByRole("button", { name: /Mara Vale/ });
    expect(mara).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(mara);

    expect(within(dialog).getByRole("alert")).toHaveTextContent("Reassign those lines before removing the participant");
    expect(mara).toHaveAttribute("aria-pressed", "true");
  });

it("authors branches and identifies affected links before destructive edits", () => {
    render(<App />);
    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;

    const maraLine = within(dialog).getByDisplayValue("Your guild forged that order. I can prove it or sail through it.");
    const maraArticle = maraLine.closest("article")!;
    fireEvent.change(maraLine, { target: { value: "The ledger proves your order was forged." } });
    fireEvent.change(within(maraArticle).getByLabelText("Next"), { target: { value: "line-dockmaster-warning" } });

    const choiceArticle = within(dialog).getByText("choice-mara-response").closest("article")!;
    fireEvent.click(within(choiceArticle).getByRole("button", { name: "Add answer" }));
    const answer = within(choiceArticle).getByLabelText("Answer 3");
    fireEvent.change(answer, { target: { value: "Ask Ilya to join the crew." } });
    const answerRow = answer.closest("div.border-t") as HTMLElement;
    fireEvent.change(within(answerRow).getByLabelText("Condition"), { target: { value: "ilya_trusts_mara" } });
    fireEvent.change(within(answerRow).getByLabelText("Next"), { target: { value: "line-ilya-concedes" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate line-mara-orders-run" }));
    expect(within(dialog).getByText("line-1")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move line-1 up" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete line-ilya-concedes" }));
    const deletionAlert = within(dialog).getByRole("alert");
    expect(deletionAlert).toHaveTextContent("2 incoming branches");
    expect(deletionAlert).toHaveTextContent("answer-show-ledger");
    fireEvent.click(within(deletionAlert).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Save dialogue" }));
    const saved = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-dock-dialogue")?.data.dialogueDocument!;
    expect(saved.elements.find((element) => element.id === "line-mara-challenge")).toMatchObject({
      next_element_id: "line-dockmaster-warning",
      text: "The ledger proves your order was forged."
    });
    expect(saved.elements.find((element) => element.id === "choice-mara-response")).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ condition: "ilya_trusts_mara", next_element_id: "line-ilya-concedes", text: "Ask Ilya to join the crew." })
      ])
    });
    expect(saved.elements.some((element) => element.id === "line-1")).toBe(true);
  });

it("creates the first line and choice in an empty dialogue", () => {
    useGraphStore.getState().addManualNode({ title: "Empty Conversation", kind: "Dialogue", summary: "New branch", tags: [] });
    render(<App />);
    const emptyDialogue = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.data.title === "Empty Conversation")!;
    fireEvent.doubleClick(screen.getByTestId(`rf__node-${emptyDialogue.id}`));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Empty Conversation" }).closest("section")!;

    const addLine = within(dialog).getByRole("button", { name: "Add line" });
    expect(addLine).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /Mara Vale/ }));
    expect(addLine).toBeEnabled();
    fireEvent.click(addLine);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add choice" }));

    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "Will you help me?" } });
    fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Choose an answer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save dialogue" }));

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === emptyDialogue.id)?.data.dialogueDocument).toMatchObject({
      entry_element_id: "line-1",
      participants: ["node-hero"],
      elements: [
        { id: "line-1", kind: "line", speaker_node_id: "node-hero", text: "Will you help me?" },
        { id: "choice-1", kind: "choice", prompt: "Choose an answer" }
      ]
    });
  });

it("creates outcomes to existing and new narrative targets", () => {
    render(<App />);
    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;

    const existingOutcomes = within(dialog).getByLabelText("Outcomes for answer-show-ledger");
    fireEvent.click(within(existingOutcomes).getByRole("button", { name: "Add outcome" }));
    fireEvent.change(within(existingOutcomes).getByLabelText("Target node"), { target: { value: "node-route-consequence" } });
    fireEvent.change(within(existingOutcomes).getByLabelText("Outcome label"), { target: { value: "reopens the route" } });
    fireEvent.change(within(existingOutcomes).getByLabelText("Relationship type"), { target: { value: "unlocks" } });
    fireEvent.click(within(existingOutcomes).getByRole("button", { name: "Create outcome" }));

    const newOutcomes = within(dialog).getByLabelText("Outcomes for answer-run-blockade");
    fireEvent.click(within(newOutcomes).getByRole("button", { name: "Add outcome" }));
    fireEvent.click(within(newOutcomes).getByRole("button", { name: "New node" }));
    expect(within(newOutcomes).getByLabelText("New node type")).toHaveValue("Event");
    fireEvent.change(within(newOutcomes).getByLabelText("New node title"), { target: { value: "Ilya Joins the Escape" } });
    fireEvent.change(within(newOutcomes).getByLabelText("New node description"), { target: { value: "Ilya boards Mara's ship." } });
    fireEvent.change(within(newOutcomes).getByLabelText("Outcome label"), { target: { value: "Ilya joins Mara" } });
    fireEvent.click(within(newOutcomes).getByRole("button", { name: "Create outcome" }));

    const graph = useGraphStore.getState().getActiveGraph();
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "node-route-consequence", data: expect.objectContaining({ dialogueElementId: "answer-show-ledger", relationshipType: "unlocks" }) }),
      expect.objectContaining({ data: expect.objectContaining({ dialogueElementId: "answer-run-blockade" }) })
    ]));
    expect(graph.nodes.at(-1)?.data).toMatchObject({ kind: "Event", title: "Ilya Joins the Escape" });
    expect(screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" })).toBeInTheDocument();
  });

it("edits outcomes and explicitly removes attached edges with their origin", async () => {
    render(<App />);
    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    const dialog = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;
    const outcomes = within(dialog).getByLabelText("Outcomes for line-mara-orders-run");

    fireEvent.change(within(outcomes).getByDisplayValue("Mara runs the blockade"), { target: { value: "Mara escapes harbor" } });
    fireEvent.change(within(outcomes).getByLabelText("Type"), { target: { value: "changes" } });
    fireEvent.change(within(outcomes).getByLabelText("Target"), { target: { value: "node-route-consequence" } });
    fireEvent.click(within(outcomes).getByRole("button", { name: "Save outcome edge-dialogue-blockade" }));
    expect(useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === "edge-dialogue-blockade")).toMatchObject({
      label: "Mara escapes harbor",
      target: "node-route-consequence",
      data: { dialogueElementId: "line-mara-orders-run", relationshipType: "changes" }
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete line-mara-orders-run" }));
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("1 external transition(s) will also be deleted");
    fireEvent.click(within(alert).getByRole("button", { name: "Delete element" }));
    await waitFor(() => expect(useGraphStore.getState().getActiveGraph().edges.some((edge) => edge.id === "edge-dialogue-blockade")).toBe(false));
    expect(screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" })).toBeInTheDocument();
  });

it("reuses and reviews deletion of a Dialogue outcome side flow", async () => {
    render(<App />);
    fireEvent.doubleClick(screen.getByTestId("rf__node-node-dock-dialogue"));
    let editor = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;
    let outcomes = within(editor).getByLabelText("Outcomes for line-mara-orders-run");
    const graph = useGraphStore.getState().getActiveGraph();
    const edge = graph.edges.find((candidate) => candidate.id === "edge-dialogue-blockade")!;
    const composition = edge.data?.outcomeFlowComposition;
    expect(composition).toMatchObject({
      invocationId: "flow-invocation-dialogue-smuggler-route",
      sourceFlowId: "flow-main-story",
      targetFlowId: "flow-z-blockade-outcome"
    });
    expect(screen.getByRole("button", { name: "Open Story Flow Blockade Outcome" })).toBeInTheDocument();

    fireEvent.click(within(outcomes).getByRole("button", { name: "Blockade Outcome" }));
    expect(screen.getByRole("button", { name: "Existing side flow" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/already references the selected call/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep semantic only" }));

    editor = screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).closest("section")!;
    outcomes = within(editor).getByLabelText("Outcomes for line-mara-orders-run");
    fireEvent.click(within(outcomes).getByRole("button", { name: "Delete outcome edge-dialogue-blockade" }));
    const impact = within(outcomes).getByRole("alert");
    expect(impact).toHaveTextContent("1 call(s), and 1 return binding(s)");
    fireEvent.click(within(impact).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(useGraphStore.getState().getActiveGraph().edges.some((candidate) => candidate.id === edge.id)).toBe(false));
  });

it("exposes every node kind in the toolbar and right-click creation menu", () => {
    const { container } = render(<App />);

    for (const kind of NARRATIVE_NODE_KINDS) {
      expect(screen.getByRole("button", { name: kind === "Scene" || kind === "Location" ? `${kind} Frame` : displayNodeKind(kind) })).toBeInTheDocument();
    }

    fireEvent.contextMenu(container.querySelector(".react-flow__pane")!, { clientX: 560, clientY: 340 });
    const contextMenu = screen.getByRole("menu", { name: "Create node" });

    for (const kind of NARRATIVE_NODE_KINDS) {
      const label = kind === "Scene" || kind === "Location" ? `${kind} Frame` : displayNodeKind(kind);
      expect(within(contextMenu).getByRole("button", { name: label })).toBeInTheDocument();
      expect(within(contextMenu).getByRole("button", { name: label })).toHaveAttribute("title", label);
    }

    fireEvent.click(within(contextMenu).getByRole("button", { name: "Requirement" }));

    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.data.title === "Requirement node" && node.data.kind === "Condition")).toBe(true);
  });

it("keeps the right-click creation menu inside the viewport", () => {
    const { container } = render(<App />);

    const workspaceRender = vi.spyOn(workspaceState, "useWorkspaceState");
    const originalNode = screen.getByTestId("rf__node-node-hero");
    fireEvent.contextMenu(container.querySelector(".react-flow__pane")!, { clientX: 560, clientY: window.innerHeight - 4 });

    expect(screen.getByRole("menu", { name: "Create node" })).toHaveStyle({ top: `${window.innerHeight - 424}px` });
    expect(workspaceRender).not.toHaveBeenCalled();
    fireEvent.contextMenu(container.querySelector(".react-flow__pane")!, { clientX: 400, clientY: 100 });
    expect(screen.getByRole("menu", { name: "Create node" })).toHaveStyle({ left: "400px", top: "100px" });
    expect(workspaceRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("rf__node-node-hero")).toBe(originalNode);
    workspaceRender.mockRestore();
  });

it("filters the canvas by search without mutating stored graph data", () => {
    render(<App />);

    const originalNode = screen.getByTestId("rf__node-node-hero");
    const workspaceRender = vi.spyOn(workspaceState, "useWorkspaceState");
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    expect(workspaceRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("rf__node-node-hero")).toBe(originalNode);
    workspaceRender.mockClear();
    fireEvent.change(screen.getByLabelText("Search graph"), { target: { value: "constraint" } });
    expect(workspaceRender).toHaveBeenCalled();

    expect(screen.getByTestId("rf__node-node-embargo")).toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-hero")).not.toBeInTheDocument();
    expect(screen.getByText("1 node / 0 relations / 0 transitions")).toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(18);

    fireEvent.click(screen.getByTitle("Reset graph filters"));

    expect(screen.getByTestId("rf__node-node-hero")).toBeInTheDocument();
    expect(screen.getByText("16 nodes / 10 relations / 5 transitions")).toBeInTheDocument();

    workspaceRender.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Hide graph filters" }));
    expect(workspaceRender).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Search graph")).not.toBeInTheDocument();
    workspaceRender.mockRestore();
  });

it("renders seeded issue overlays and filters them by severity and status", () => {
    render(<App />);

    expect(screen.getByTestId("rf__node-node-hero")).toHaveTextContent("1");
    expect(screen.getByTestId("rf__node-node-hero").querySelector(".issue-badge")).toHaveAttribute(
      "data-preview",
      expect.stringContaining("Voice conflict")
    );
    expect(screen.getByTestId("rf__node-node-embargo")).toHaveTextContent("1");
    const containedIssue = screen.getByTestId("rf__node-node-embargo").querySelector<HTMLElement>(".issue-badge")!;
    const containedWrapper = containedIssue.closest(".react-flow__node")!;
    fireEvent.mouseEnter(containedIssue);
    expect(containedWrapper).toHaveClass("issue-tooltip-active");
    fireEvent.mouseLeave(containedIssue);
    expect(containedWrapper).not.toHaveClass("issue-tooltip-active");
    fireEvent.focus(containedIssue);
    expect(containedWrapper).toHaveClass("issue-tooltip-active");
    fireEvent.blur(containedIssue);
    expect(containedWrapper).not.toHaveClass("issue-tooltip-active");

    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    fireEvent.click(screen.getByText("Warning"));
    fireEvent.click(screen.getByText("Info"));

    expect(screen.queryByTestId("rf__node-node-hero")?.querySelector(".issue-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-embargo")?.querySelector(".issue-badge")).not.toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().issues).toHaveLength(3);
  });

it("analyzes scene text and renders patch preview without mutating the graph", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/suggestions/suggestion-preview/operations/0/reject")) {
        return jsonResponse({
          id: "suggestion-preview",
          project_id: "project-aurora",
          title: "Rejected",
          description: "",
          status: "pending",
          patch: {},
          created_by: "local-user",
          metadata: { operation_decisions: { "0": "rejected" } },
          created_at: "2026-07-11T00:00:00Z",
          updated_at: "2026-07-11T00:00:00Z"
        });
      }
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        project_id: "project-aurora",
        provider: "deterministic",
        scene_text: expect.stringContaining("Character: Mara Vale"),
        title: "Project Aurora graph review"
      });
      return jsonResponse({
        project_id: "project-aurora",
        suggestion_id: "suggestion-preview",
        provider: "deterministic",
        extracted_facts: [
          {
            id: "fact-mara",
            kind: "node",
            title: "Mara Vale",
            summary: "Smuggler captain.",
            evidence: { text: "Character: Mara Vale", start: 0, end: 20 },
            metadata: { node_kind: "Character" }
          }
        ],
        patch: {
          title: "Harbor Inspection graph suggestions",
          description: "Suggested graph updates.",
          operations: [
            {
              op: "create_node",
              client_id: "node-character-mara-vale",
              node: {
                kind: "Character",
                title: "Mara Vale",
                summary: "Smuggler captain.",
                body: "",
                status: "suggested",
                metadata: {}
              }
            },
            {
              op: "create_edge",
              client_id: "edge-mara-location",
              edge: {
                source: { node_id: "node-hero" },
                target: { node_id: "node-harbor" },
                relationship_type: "located_in",
                label: "located in",
                condition: "",
                metadata: {}
              }
            }
          ],
          metadata: {}
        },
        warnings: []
      });
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");

    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));

    expect(await within(panel).findByText("Extracted facts")).toBeInTheDocument();
    expect(within(panel).getByText("Suggested node")).toBeInTheDocument();
    expect(within(panel).getByText("Suggested edge")).toBeInTheDocument();
    expect(within(panel).getByText("Character: Mara Vale")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-node-harbor")).toHaveTextContent("analysis");
    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(18);

    fireEvent.click(within(screen.getByTestId("rf__node-node-harbor")).getByTitle("Review analysis suggestion"));
    expect(screen.getByLabelText("Analysis suggestion review")).toHaveTextContent("located in");
    fireEvent.click(screen.getByTitle("Close dialog"));

    fireEvent.click(within(panel).getAllByRole("button", { name: "Reject" })[0]!);
    await waitFor(() => expect(within(panel).getByText("Rejected")).toBeInTheDocument());
    expect(screen.getByTestId("rf__node-node-harbor")).toHaveTextContent("analysis");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8719/api/suggestions/suggestion-preview/operations/0/reject",
      expect.objectContaining({ method: "POST" })
    );
    fireEvent.click(within(panel).getByTitle("Close scene analysis"));
    expect(screen.queryByLabelText("Scene analysis")).not.toBeInTheDocument();
  });

it("approves a persisted scene suggestion and reloads the canonical graph", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/analysis/scenes")) {
        return jsonResponse({
          project_id: "project-aurora",
          suggestion_id: "suggestion-preview",
          provider: "deterministic",
          extracted_facts: [],
          patch: {
            title: "Preview",
            description: "",
            operations: [
              {
                op: "create_node",
                client_id: "node-new",
                node: { kind: "Scene", title: "Approved Scene", summary: "Applied", body: "", status: "suggested", metadata: {} }
              }
            ],
            metadata: {}
          },
          warnings: []
        });
      }
      if (input.endsWith("/suggestions/suggestion-preview/operations/0/approve")) {
        return jsonResponse({
          id: "suggestion-preview",
          project_id: "project-aurora",
          title: "Approved",
          description: "",
          status: "approved",
          patch: {},
          created_by: "local-user",
          metadata: { operation_decisions: { "0": "approved" } },
          created_at: "2026-07-11T00:00:00Z",
          updated_at: "2026-07-11T00:00:00Z"
        });
      }
      if (input.endsWith("/projects")) {
        return jsonResponse([
          {
            id: "project-aurora",
            name: "Project Aurora",
            path: "~/Stories/ProjectAurora.narrative",
            format_version: 1,
            metadata: {},
            created_at: "2026-07-11T00:00:00Z",
            updated_at: "2026-07-11T00:00:00Z"
          }
        ]);
      }
      if (input.includes("/nodes?")) {
        return jsonResponse([
          {
            id: "node-approved",
            project_id: "project-aurora",
            type: "Scene",
            title: "Approved Scene",
            summary: "Applied",
            body: "",
            status: "canon",
            metadata: {},
            created_at: "2026-07-11T00:00:00Z",
            updated_at: "2026-07-11T00:00:00Z"
          }
        ]);
      }
      if (input.includes("/edges?") || input.includes("/issues?")) {
        return jsonResponse([]);
      }
      if (input.includes("/compositions?")) {
        return jsonResponse({ composition_version: 1, project_id: "project-aurora", placements: [], semantic_relationships: [] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");
    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));
    await within(panel).findByRole("button", { name: "Approve" });

    fireEvent.click(within(panel).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(useGraphStore.getState().getActiveGraph().nodes[0]?.data.title).toBe("Approved Scene"));
    expect(within(panel).getByLabelText("Patch preview")).toHaveTextContent("Approved");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8719/api/suggestions/suggestion-preview/operations/0/approve",
      expect.objectContaining({ method: "POST" })
    );
  });

it("shows scene analysis loading and error states", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetcher);

    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");
    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));

    expect(within(panel).getByRole("button", { name: "Analyzing" })).toBeDisabled();

    resolveFetch(new Response("{}", { status: 500, statusText: "Server Error" }));

    await waitFor(() => expect(within(panel).getByText("Analysis failed: Runtime request failed: 500 Server Error. Showing local preview.")).toBeInTheDocument());
    expect(within(panel).getByLabelText("Patch preview")).toBeInTheDocument();
  });

it("shows the local privacy boundary and structured provider failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: { code: "provider_unavailable", message: "The configured analysis provider is unavailable." } }), {
          headers: { "Content-Type": "application/json" },
          status: 503,
          statusText: "Service Unavailable"
        })
      )
    );
    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");

    expect(within(panel).getByText("Local deterministic provider. Scene text stays on this device.")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));

    expect(await within(panel).findByText("Provider unavailable: The configured analysis provider is unavailable. Showing local preview.")).toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(18);
  });

it("applies and remembers approved operations in local fallback mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503, statusText: "Offline" })));
    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");
    fireEvent.change(within(panel).getByLabelText("Scene text"), {
      target: { value: "Character: Mara Vale - Updated by local analysis." }
    });

    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));
    await within(panel).findByRole("button", { name: "Approve" });
    fireEvent.click(within(panel).getByRole("button", { name: "Analyze impact" }));
    const impact = screen.getByRole("complementary", { name: "Impact analysis" });
    expect(impact).toHaveTextContent("Mara Vale");
    fireEvent.click(within(impact).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Analyze impact" })).toHaveFocus());
    fireEvent.click(within(panel).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")?.data.summary).toBe("Updated by local analysis."));
  });

it("does not repeat a locally rejected operation during reanalysis", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503, statusText: "Offline" })));
    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");
    fireEvent.change(within(panel).getByLabelText("Scene text"), {
      target: { value: "Character: Mara Vale - Rejected summary." }
    });

    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Reject" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Analyze scene" }));

    await waitFor(() => expect(within(panel).getByText("No applicable graph changes were found.")).toBeInTheDocument());
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")?.data.summary).not.toBe("Rejected summary.");
  });

it("fills and restores scene analysis text from the active graph", () => {
    render(<App sceneTextImportEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene analysis" }));
    const panel = screen.getByLabelText("Scene analysis");
    fireEvent.change(within(panel).getByLabelText("Scene title"), { target: { value: "Changed" } });
    fireEvent.change(within(panel).getByLabelText("Scene text"), { target: { value: "Changed scene" } });

    fireEvent.click(within(panel).getByRole("button", { name: "Refresh from graph" }));

    expect(within(panel).getByLabelText("Scene title")).toHaveValue("Changed");
    const sceneText = (within(panel).getByLabelText("Scene text") as HTMLTextAreaElement).value;
    expect(sceneText).toContain("Relationship: Opening Dock located_in Glass Harbor");
    expect(sceneText).toContain("Item: Sealed Ledger");
  });

it("serializes nodes and typed edges into analyzer input", () => {
    const graph = useGraphStore.getState().getActiveGraph();

    const sceneText = buildGraphAnalysisText(graph.nodes, graph.edges);

    expect(sceneText).toContain("Character: Mara Vale - Smuggler captain");
    expect(sceneText).toContain("Relationship: Opening Dock located_in Glass Harbor");
    expect(sceneText.match(/Item: Sealed Ledger/g)).toHaveLength(1);
  });

it("shows relationship inspection for selected nodes and focuses connected nodes", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("rf__node-node-opening"));
    const panel = screen.getByLabelText("Relationship inspection");

    expect(within(panel).getByText("Relationships")).toBeInTheDocument();
    expect(within(panel).getByText("Incoming")).toBeInTheDocument();
    expect(within(panel).getByText("Outgoing")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Mara Vale appears in/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Silver Embargo reveals/ })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: /Silver Embargo reveals/ }));

    expect(useGraphStore.getState().selection).toEqual({ type: "node", id: "node-embargo" });
  });

it("focuses relationship nodes directly without redundant focus-history controls", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Scene: Opening Dock" }));
    fireEvent.click(within(screen.getByLabelText("Relationship inspection")).getByRole("button", { name: /Silver Embargo reveals/ }));

    expect(useGraphStore.getState().selection).toEqual({ type: "node", id: "node-embargo" });
    expect(screen.queryByTitle("Back focus")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Forward focus")).not.toBeInTheDocument();
    expect(screen.getByTitle("Focus neighborhood")).toBeEnabled();
  });

it("shows relationship inspection for selected edges", () => {
    render(<App />);

    act(() => useGraphStore.getState().selectItem({ type: "edge", id: "edge-hero-opening" }));
    const panel = screen.getByLabelText("Relationship inspection");

    expect(within(panel).getByText("Type")).toBeInTheDocument();
    expect(within(panel).getByText("Label")).toBeInTheDocument();
    expect(within(panel).getAllByText("appears in").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByRole("button", { name: /Mara Vale/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Opening Dock/ })).toBeInTheDocument();
  });

it("edits a selected Story Flow transition after creation", async () => {
    const transition = PROJECT_AURORA_STORY_FLOWS[0]!.transitions[0]!;
    render(<App />);
    act(() => useGraphStore.getState().selectItem({ type: "edge", id: `story-flow:${transition.id}` }));

    fireEvent.click(screen.getByRole("button", { name: "Edit Story Flow transition" }));
    const dialog = screen.getByRole("heading", { name: "Edit Story Flow transition" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Transition type"), { target: { value: "optional" } });
    fireEvent.change(within(dialog).getByLabelText("Label"), { target: { value: "Revised optional route" } });
    fireEvent.click(within(dialog).getByLabelText("Default"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit Story Flow transition" })).not.toBeInTheDocument());
    const panel = screen.getByLabelText("Story Flow transition details");
    expect(panel).toHaveTextContent("Revised optional route");
    expect(panel).toHaveTextContent("Optional");
    expect(panel).toHaveTextContent("Yes");
  });

it("opens node editor and saves text and tags", () => {
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-hero"));
    const dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getAllByRole("option").map((option) => option.textContent)).toEqual(NARRATIVE_NODE_KINDS.map(displayNodeKind));
    expect(within(dialog).getByLabelText("Issue details")).toHaveTextContent("Voice conflict");
    expect(within(dialog).getByText("Mara's summary hints at a contradiction that needs canon review.")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "Expanded character text" } });
    fireEvent.change(within(dialog).getByLabelText("Tags"), { target: { value: "hero, crew" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    const node = useGraphStore.getState().getActiveGraph().nodes.find((candidate) => candidate.id === "node-hero")!;
    expect(node.data.summary).toBe("Expanded character text");
    expect(node.data.tags).toEqual(["hero", "crew"]);
  });

it("opens edge editor and saves type and label", () => {
    const onSave = vi.fn();
    render(
      <EditEdgeDialog
        edge={{
          data: { label: "appears in", relationshipType: "appears_in" },
          label: "appears in",
          source: "node-hero",
          sourceHandle: "right",
          target: "node-opening",
          targetHandle: "left"
        }}
        issues={[
          {
            id: "issue-edge",
            projectId: "project-aurora",
            edgeId: "edge-hero-opening",
            nodeId: null,
            title: "Connection mismatch",
            description: "Clarify why the character appears here.",
            severity: "info",
            status: "open"
          }
        ]}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    const dialog = screen.getByRole("heading", { name: "Edit edge" }).closest("section")!;
    expect(within(dialog).getByLabelText("Issue details")).toHaveTextContent("Connection mismatch");
    expect(within(dialog).getByLabelText("Relationship type")).toHaveValue("appears_in");
    fireEvent.change(within(dialog).getByLabelText("Relationship type"), { target: { value: "reveals" } });
    fireEvent.change(within(dialog).getByLabelText("Label"), { target: { value: "foreshadows" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      label: "foreshadows",
      relationshipType: "reveals",
      source: "node-hero",
      sourceHandle: "right",
      target: "node-opening",
      targetHandle: "left"
    });
  });

it("focuses a graph node from the project rail", () => {
    const onFocusNode = vi.fn();
    const node = {
      data: { kind: "Scene" as const, label: "Opening Dock", summary: "Intro", tags: [], title: "Opening Dock" },
      id: "node-opening",
      position: { x: 420, y: 80 },
      width: 260
    };

    render(
      <CurrentProjectPanel
        nodes={[node]}
        onFocusNode={onFocusNode}
        project={{
          description: "Primary sample workspace.",
          name: "Project Aurora",
          path: "~/Stories/ProjectAurora.narrative",
          updatedAt: "2026-05-26"
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Scene: Opening Dock" }));

    expect(onFocusNode).toHaveBeenCalledWith(node);
  });

it("uses projected Flow coordinates when focusing a member from navigation", () => {
    const canonical = {
      data: { kind: "Event" as const, label: "Inspection", summary: "", tags: [], title: "Inspection" },
      id: "node-inspection",
      position: { x: 900, y: 700 },
      type: "narrative" as const
    };
    const projected = { ...canonical, position: { x: 320, y: 140 }, width: 200 };

    expect(nodeForWorkspaceFocus(canonical, [projected], "flow")).toBe(projected);
    expect(nodeForWorkspaceFocus(canonical, [projected], "relationships")).toBe(canonical);
    expect(nodeForWorkspaceFocus(canonical, [], "flow")).toBe(canonical);
  });

it("keeps Flow member actions separate from a long truncated node title", () => {
    const node = {
      data: { kind: "Event" as const, label: "Long event", summary: "", tags: [], title: "A very long customs inspection event name that must stay inside the project rail" },
      id: "node-long",
      position: { x: 0, y: 0 }
    };
    const flow = {
      snapshot_version: 1 as const,
      flow: {
        flow_version: 1 as const, id: "flow-long", project_id: "project", name: "Main", description: "",
        kind: "main" as const, status: "active" as const, entry_node_id: null, metadata: {},
        created_at: "2026-07-24T10:00:00Z", updated_at: "2026-07-24T10:00:00Z"
      },
      nodes: [{
        flow_node_version: 1 as const, id: "membership-long", project_id: "project", flow_id: "flow-long",
        node_id: node.id, presentation_order: 0, metadata: {},
        created_at: "2026-07-24T10:00:00Z", updated_at: "2026-07-24T10:00:00Z"
      }],
      transitions: [],
      scene_boundaries: [],
      scene_children: {}
    };

    render(<CurrentProjectPanel activeFlowId={flow.flow.id} flows={[flow]} nodes={[node]} onContinueFlow={vi.fn()} onFocusNode={vi.fn()} onSetFlowEntry={vi.fn()} project={{ description: "", name: "Project", path: "~/Project", updatedAt: "today" }} />);

    const title = screen.getByTitle(node.data.title);
    expect(title).toHaveClass("project-flow-member-title");
    expect(title.parentElement).toHaveClass("project-flow-member");
    expect(screen.getByRole("button", { name: `Continue from ${node.data.title}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Set ${node.data.title} as flow entry` })).toBeInTheDocument();
  });

it("keeps visible seed examples for the expanded node kind contract", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const seedKinds = new Set(graph.nodes.map((node) => node.data.kind));

    expect(NARRATIVE_NODE_KINDS.every((kind) => seedKinds.has(kind))).toBe(true);

    render(<App />);

    expect(screen.getByTestId("rf__node-node-harbor")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-node-route-consequence")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-placement:seed-ledger-opening")).toHaveTextContent("Sealed Ledger");
    expect(screen.getAllByLabelText("Linked visual instance")).toHaveLength(2);
  });

it("hides edges attached to filtered-out nodes", () => {
    const graph = useGraphStore.getState().getActiveGraph();

    expect(filterGraphForView(graph.nodes, graph.edges, { kinds: ["Scene"], query: "" })).toMatchObject({
      edges: [],
      nodes: [{ id: "node-opening" }]
    });
    expect(filterGraphForView(graph.nodes, graph.edges, { kinds: ["Character", "Scene"], query: "" }).edges).toHaveLength(1);
    expect(filterGraphForView(graph.nodes, graph.edges, { kinds: ["Scene", "Lore"], query: "constraint" })).toMatchObject({
      edges: [],
      nodes: [{ id: "node-embargo" }]
    });
  });

it("maps and filters issue overlays for nodes and edges", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const visibleIssues = filterIssuesForView(graph.issues, {
      issueSeverities: ["critical", "warning"],
      issueStatuses: ["open", "review"]
    });
    const overlayGraph = applyIssueOverlays(graph.nodes, graph.edges, visibleIssues);

    expect(visibleIssues).toHaveLength(2);
    expect(overlayGraph.nodes.find((node) => node.id === "node-hero")?.data).toMatchObject({
      issueCount: 1,
      issueSeverity: "warning"
    });
    expect(overlayGraph.nodes.find((node) => node.id === "node-embargo")?.data.issueCount).toBe(0);
    expect(overlayGraph.edges.find((edge) => edge.id === "edge-opening-embargo")).toMatchObject({
      data: { issueCount: 1, issueSeverity: "critical" },
      style: { stroke: "#dc2626", strokeWidth: 4 }
    });
  });

it("builds navigation neighborhood and selection edge highlights", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const neighborhood = getNodeNeighborhood(graph.nodes, graph.edges, "node-opening");
    const highlightedEdges = applySelectionHighlights(graph.edges, { type: "node", id: "node-opening" });

    expect(neighborhood.nodes.map((node) => node.id).sort()).toEqual(["node-embargo", "node-harbor", "node-hero", "node-opening"]);
    expect(neighborhood.edges.map((edge) => edge.id).sort()).toEqual([
      "edge-hero-opening",
      "edge-opening-embargo",
      "edge-opening-harbor"
    ]);
    expect(
      highlightedEdges
        .filter((edge) => edge.source === "node-opening" || edge.target === "node-opening")
        .every((edge) => edge.style?.strokeWidth === 5)
    ).toBe(true);
    expect(highlightedEdges.find((edge) => edge.id === "edge-guild-ledger")?.style?.strokeWidth).toBe(3);
  });

it("builds analysis preview highlights from patch operations against the visible graph", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const preview = buildAnalysisPreviewMaps(
      {
        project_id: "project-aurora",
        provider: "deterministic",
        extracted_facts: [],
        patch: {
          title: "Preview",
          description: "",
          metadata: {},
          operations: [
            {
              op: "create_node",
              client_id: "node-mara",
              node: {
                kind: "Character",
                title: "Mara Vale",
                summary: "Updated",
                body: "",
                status: "suggested",
                metadata: {}
              }
            },
            {
              op: "create_edge",
              client_id: "edge-mara-harbor",
              edge: {
                source: { client_id: "node-mara" },
                target: { node_id: "node-harbor" },
                relationship_type: "located_in",
                label: "located in",
                condition: "",
                metadata: {}
              }
            }
          ]
        },
        warnings: []
      },
      graph.nodes,
      graph.edges
    );

    expect(preview.nodes.get("node-hero")).toContain("Character: Mara Vale");
    expect(preview.nodes.get("node-harbor")).toContain("located in");
    expect(preview.previewEdges).toHaveLength(1);
    expect(preview.previewEdges[0]).toMatchObject({
      data: { analysisOperationIndex: 1 },
      label: "analysis",
      source: "node-hero",
      target: "node-harbor"
    });
  });

it("builds a local scene analysis preview against the current graph when runtime is unavailable", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const result = buildLocalSceneAnalysisPreview(
      "project-aurora",
      "Harbor Inspection",
      [
        "Character: Mara Vale - Smuggler captain carrying the sealed ledger.",
        "Location: Glass Harbor - Neutral port under embargo patrol.",
        "Relationship: Mara Vale located_in Glass Harbor - Mara reaches the harbor at dusk."
      ].join("\n"),
      graph.nodes
    );
    const preview = buildAnalysisPreviewMaps(result, graph.nodes, graph.edges);

    expect(result.suggestion_id).toBeNull();
    expect(result.warnings).toContain("Runtime unavailable; this preview is not persisted.");
    expect(preview.nodes.get("node-hero")).toContain("Update Mara Vale");
    expect(preview.nodes.get("node-harbor")).toContain("Update Glass Harbor");
    expect(preview.previewEdges[0]).toMatchObject({ label: "analysis", source: "node-hero", target: "node-harbor" });
  });

it("builds read-only relationship inspection data", () => {
    const graph = useGraphStore.getState().getActiveGraph();

    expect(buildRelationshipInspection(graph.nodes, graph.edges, { type: "node", id: "node-opening" })).toMatchObject({
      incoming: [{ label: "appears in", node: { id: "node-hero" } }],
      itemTitle: "Opening Dock",
      outgoing: [
        { label: "reveals", node: { id: "node-embargo" } },
        { label: "located in", node: { id: "node-harbor" } }
      ],
      type: "node"
    });
    expect(buildRelationshipInspection(graph.nodes, graph.edges, { type: "edge", id: "edge-hero-opening" })).toMatchObject({
      edge: {
        label: "appears in",
        source: { id: "node-hero" },
        target: { id: "node-opening" },
        type: "appears_in"
      },
      type: "edge"
    });
  });

it("configures Scene entry and multiple exits only from Flow member children", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const flow = PROJECT_AURORA_STORY_FLOWS[0]!;
    const child = graph.nodes.find((node) => node.id === "node-dock-dialogue")!;
    const nonMember = graph.nodes.find((node) => node.id === "node-harbor")!;
    const onSave = vi.fn();

    render(
      <SceneFlowBoundaryDialog
        boundary={flow.scene_boundaries[0]!}
        children={[child, nonMember]}
        flow={flow}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onSave={onSave}
        sceneTitle="Opening Dock"
      />
    );

    expect(screen.getByRole("option", { name: /Dockmaster Warning/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Glass Harbor/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save boundary" }));
    expect(onSave).toHaveBeenCalledWith("node-dock-dialogue", ["node-dock-dialogue"]);
  });

it("keeps a specialized outcome semantic until an explicit Flow is selected", () => {
    const storedEdge = useGraphStore.getState().getActiveGraph().edges.find((candidate) => candidate.id === "edge-dialogue-blockade")!;
    const edge = { ...storedEdge, data: { ...storedEdge.data!, outcomeFlowComposition: undefined } };
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <OutcomeFlowDialog
        edge={edge}
        error={null}
        flows={PROJECT_AURORA_STORY_FLOWS}
        onClose={onClose}
        onSave={onSave}
        preferredFlowId="flow-main-story"
      />
    );

    expect(screen.getByRole("combobox", { name: "Parent Story Flow" })).toHaveValue("flow-main-story");
    fireEvent.click(screen.getByRole("button", { name: "Keep semantic only" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Transition type" }), { target: { value: "optional" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Story Flow" }));
    expect(onSave).toHaveBeenCalledWith({ condition: "", kind: "optional", mode: "direct", sourceFlowId: "flow-main-story" });

    onSave.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Existing side flow" }));
    expect(screen.getByRole("combobox", { name: "Called Story Flow" })).toHaveValue("flow-smuggler-route");
    fireEvent.click(screen.getByRole("button", { name: "Use Story Flow call" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: "existing", sourceFlowId: "flow-main-story", targetFlowId: "flow-smuggler-route" }));

    onSave.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "New side flow" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Side flow name" }), { target: { value: "Alternate Blockade Outcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Use Story Flow call" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: "new", newFlowName: "Alternate Blockade Outcome", sourceFlowId: "flow-main-story" }));
  });

it("reviews unresolved progression with membership and relationship disposition", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const base = projectProgressionMigrationReview("project-aurora", graph.edges, PROJECT_AURORA_STORY_FLOWS);
    const stale = rejectProgressionCandidateLocally({
      ...base.pending[0]!,
      fingerprint: "stale-fingerprint",
      label: "Previously rejected wording"
    });
    const review = { ...base, decisions: [...base.decisions, stale] };
    const onAccept = vi.fn();
    const onReject = vi.fn();

    render(
      <ProgressionMigrationDialog
        error={null}
        flows={PROJECT_AURORA_STORY_FLOWS}
        loading={false}
        nodes={graph.nodes}
        onAccept={onAccept}
        onClose={vi.fn()}
        onReject={onReject}
        review={review}
      />
    );

    const candidate = screen.getByRole("article", { name: /Migration candidate reopens the legal route/ });
    expect(candidate).toHaveTextContent("Confirm membership additions: Smuggler Route");
    expect(screen.getByLabelText("Migration decision history")).toHaveTextContent("accepted");
    expect(screen.getByLabelText("Migration decision history")).toHaveTextContent("rejected");
    fireEvent.change(within(candidate).getByLabelText("Transition type"), { target: { value: "next" } });
    fireEvent.click(within(candidate).getByLabelText("Preserve original relationship"));
    fireEvent.click(within(candidate).getByRole("button", { name: "Accept conversion" }));
    const selectedCandidate = base.pending.find((candidate) => candidate.edge_id === "edge-quest-legal-route")!;
    expect(onAccept).toHaveBeenCalledWith(
      selectedCandidate,
      expect.objectContaining({ flowId: "flow-main-story", kind: "next", preserveRelationship: false })
    );
    fireEvent.click(within(candidate).getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith(selectedCandidate);
  });
});

function cleanProjectSessionResponse() {
  const timestamp = "2026-07-28T10:00:00Z";
  return {
    session: {
      session_version: 1,
      session_id: "session-clean",
      project_id: "project-clean",
      project_path: "/stories/CleanStart.narrative",
      storage_mode: "local_sqlite",
      loaded_revision: 0,
      saved_revision: 0,
      save_status: "clean",
      lifecycle: "open",
      opened_at: timestamp,
      last_saved_at: timestamp,
      save_error: null
    },
    document: {
      document_version: 5,
      checksum: "checksum",
      manifest: {
        format_version: 2,
        project_id: "project-clean",
        name: "Clean Start",
        description: "",
        created_at: timestamp,
        updated_at: timestamp,
        saved_revision: 0,
        settings_version: PROJECT_SETTINGS_VERSION,
        settings: createDefaultProjectSettings(),
        asset_paths: []
      },
      project_metadata: {},
      nodes: [],
      edges: [],
      issues: [],
      suggestions: [],
      engine_tags: [],
      placements: [],
      dialogues: [],
      quests: [],
      story_flows: [],
      story_flow_nodes: [],
      flow_transitions: [],
      scene_flow_boundaries: [],
      flow_invocations: [],
      flow_exits: [],
      flow_exit_bindings: [],
      flow_initial_states: [],
      narrative_effects: [],
      narrative_effect_bindings: []
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}
