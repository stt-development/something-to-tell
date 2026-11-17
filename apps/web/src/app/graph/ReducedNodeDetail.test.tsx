import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ReducedNodeDetail, nodeDetailPreview } from "./ReducedNodeDetail";

it.each(["overview", "compact", "folded"] as const)("%s retains visible title and authored preview without Reveal", (mode) => {
  const { container, getByText } = render(<ReducedNodeDetail data={{ kind: "Lore", title: "Ledger", summary: "The ledger names the informant." }}
    presentation={{ mode, depth: 5, foldedDirect: 0, foldedDescendants: 0 }} onReveal={vi.fn()} />);
  expect(getByText("Lore: Ledger")).toBeVisible(); expect(getByText("The ledger names the informant.")).toBeVisible();
  expect(container.querySelector(".sr-only")).toBeNull();
});
it("bounds normalization and preserves surrogate pairs without mutating the text", () => {
  const text = "a".repeat(319) + "\u{1f680}" + "b".repeat(10000);
  expect(nodeDetailPreview(text)).toBe("a".repeat(319) + "...");
  expect(nodeDetailPreview("Line one\n\nLine two")).toBe("Line one Line two"); expect(nodeDetailPreview("")).toBe("");
  expect(text.length).toBe(10321);
});
it("frame text has a separate bounded header preview, not a hover replacement for children", () => {
  const { container } = render(<ReducedNodeDetail data={{ kind: "Location", title: "Harbor", summary: "A guarded quay.", isFrame: true }}
    presentation={{ mode: "compact", depth: 2, foldedDirect: 1, foldedDescendants: 3 }} onReveal={vi.fn()} />);
  expect(container.querySelector(".node-detail-frame-preview")).toHaveTextContent("A guarded quay.");
  expect(container.querySelector("[data-preview]")).toBeNull();
});
