import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CurrentProjectPanel } from "./ProjectPanels";
import type { NarrativeNodeData } from "../../types";
import { installProjectNavigationGeometry } from "../../test/projectNavigationGeometry";

let restore: () => void;
beforeEach(() => { restore = installProjectNavigationGeometry(); });
afterEach(() => restore());

it("does not rescan parent membership on metadata-only rerenders but observes replacement node inputs", () => {
  let reads = 0;
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), position: { x: 0, y: 0 },
    get parentId() { reads++; return undefined; },
    data: { kind: "Lore", title: `Fact ${i}`, label: `Fact ${i}`, summary: "Text", tags: [] } as NarrativeNodeData }));
  const onFocusNode = vi.fn(), project = { name: "Project", description: "Initial", path: "offline-project", updatedAt: "today" };
  const view = render(<CurrentProjectPanel nodes={nodes} onFocusNode={onFocusNode} project={project} />);
  const first = reads; expect(first).toBe(1000);
  view.rerender(<CurrentProjectPanel nodes={nodes} onFocusNode={onFocusNode} project={{ ...project, description: "Updated" }} />);
  expect(reads - first).toBe(0);
  const replacement = nodes.map((node, index) => index ? node : { ...node, data: { ...node.data, title: "Changed fact" } });
  const before = reads;
  view.rerender(<CurrentProjectPanel nodes={replacement} onFocusNode={onFocusNode} project={project} />);
  expect(reads - before).toBe(999); // Object spread materializes only the replaced row's getter.
  fireEvent.click(view.getByRole("button", { name: "Lore: Changed fact" })); expect(onFocusNode).toHaveBeenCalledWith(replacement[0]);
});
