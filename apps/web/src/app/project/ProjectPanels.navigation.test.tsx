import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CurrentProjectPanel } from "./ProjectPanels";
import { installProjectNavigationGeometry } from "../../test/projectNavigationGeometry";
import { projectFixture } from "../../testFixtures/projectFixtures";
import type { NarrativeNodeData } from "../../types";

let restore: () => void;
beforeEach(() => { restore = installProjectNavigationGeometry(); });
afterEach(() => restore());

it("bounds all three long navigation surfaces while retaining distant Flow/member/tree commands", async () => {
  const source = projectFixture("aurora").storyFlows[0]!;
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `node-${i}`, position: { x: i, y: 0 },
    data: { kind: "Lore", title: `Fact ${i}`, label: `Fact ${i}`, summary: "Text", tags: [] } as NarrativeNodeData }));
  const flows = Array.from({ length: 1000 }, (_, i) => ({ ...source, flow: { ...source.flow, id: `flow-${i}`, name: `Route ${i}` },
    nodes: i ? [] : nodes.map((node, index) => ({ ...source.nodes[0]!, id: `member-${index}`, node_id: node.id, presentation_order: index })) }));
  const onSelectFlow = vi.fn(), onRenameFlow = vi.fn(), onArchiveFlow = vi.fn(), onDeleteFlow = vi.fn();
  const onFocusNode = vi.fn(), onContinueFlow = vi.fn(), onCallFlow = vi.fn(), onCreateFlowExit = vi.fn(), onSetFlowEntry = vi.fn(), onDragNode = vi.fn();
  const view = render(<CurrentProjectPanel activeFlowId="flow-0" flows={flows} nodes={nodes}
    project={{ name: "Long project", description: "Description", path: "offline", updatedAt: "today" }}
    {...{ onSelectFlow, onRenameFlow, onArchiveFlow, onDeleteFlow, onFocusNode, onContinueFlow, onCallFlow, onCreateFlowExit, onSetFlowEntry, onDragNode }} />);
  expect(view.getAllByRole("list")).toHaveLength(3);
  for (const list of view.getAllByRole("list")) {
    expect(within(list).getAllByRole("listitem").length).toBeLessThan(25);
    act(() => within(list).getAllByRole("button")[0]!.focus());
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await waitFor(() => expect(document.activeElement?.closest("[data-nav-index]")).toHaveAttribute("data-nav-index", "999"));
    const row = document.activeElement!.closest("[data-nav-index]")!;
    for (const button of within(row as HTMLElement).getAllByRole("button")) fireEvent.click(button);
    if (list.getAttribute("aria-label") === "Graph") {
      expect(row.querySelector(".project-tree-row")).toHaveAttribute("data-node-id", "node-999");
      fireEvent.dragStart(within(row as HTMLElement).getByRole("button"));
    }
  }
  expect(onSelectFlow).toHaveBeenCalledWith("flow-999"); expect(onRenameFlow).toHaveBeenCalledWith("flow-999");
  expect(onArchiveFlow).toHaveBeenCalledWith(flows[999]); expect(onDeleteFlow).toHaveBeenCalledWith(flows[999]);
  expect(onFocusNode).toHaveBeenCalledWith(nodes[999]); expect(onContinueFlow).toHaveBeenCalledWith("node-999");
  expect(onCallFlow).toHaveBeenCalledWith("node-999"); expect(onCreateFlowExit).toHaveBeenCalledWith("node-999");
  expect(onSetFlowEntry).toHaveBeenCalledWith("node-999"); expect(onDragNode).toHaveBeenCalledWith("node-999", expect.anything());
});
