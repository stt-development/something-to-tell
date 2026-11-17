import { ReactFlow, ReactFlowProvider, type Node, type NodeChange } from "@xyflow/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";

it("rejects callback-only admission: ghost selection suppresses the next Enter until native Escape clears it", async () => {
  function Probe() {
    const [nodes, setNodes] = useState<Node[]>([{ id: "node", position: { x: 0, y: 0 },
      width: 260, height: 156, measured: { width: 260, height: 156 }, data: { label: "Node" } }]);
    const [allow, setAllow] = useState(false);
    return <><button onClick={() => setAllow(true)}>Select</button>
      <ReactFlow nodes={nodes} elementsSelectable width={800} height={600}
        onNodesChange={(changes: NodeChange[]) => {
          if (allow) setNodes(current => current.map(node => {
            const selected = changes.find(change => change.type === "select" && change.id === node.id);
            return selected?.type === "select" ? { ...node, selected: selected.selected } : node;
          }));
        }} />
    </>;
  }
  const view = render(<ReactFlowProvider><Probe /></ReactFlowProvider>);
  await act(async () => {});
  const node = view.getByTestId("rf__node-node");
  fireEvent.keyDown(node, { key: "Enter" });
  expect(node).not.toHaveClass("selected");
  fireEvent.click(view.getByText("Select", { selector: "button" }));
  fireEvent.keyDown(node, { key: "Enter" });
  // Negative control for ADR0028, not the production selection contract.
  expect(node).not.toHaveClass("selected");
  fireEvent.keyDown(node, { key: "Escape" });
  fireEvent.keyDown(node, { key: "Enter" });
  await waitFor(() => expect(node).toHaveClass("selected"));
});
