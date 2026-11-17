import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectNavigationList } from "./ProjectNavigationList";
import { installProjectNavigationGeometry } from "../../test/projectNavigationGeometry";

let restore: () => void;
beforeEach(() => { restore = installProjectNavigationGeometry(); });
afterEach(() => restore());
const key = (item: { id: string }) => item.id;
const items = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), title: `Fact ${i}` }));

function fixture(input = items) {
  const click = vi.fn();
  const props = { items: input, itemKey: key, label: "Graph", rowHeight: 24,
    renderItem: (item: typeof items[number]) => <><button draggable onClick={() => click(item)}>{item.title}</button><button>Action {item.id}</button></> };
  return { ...render(<ProjectNavigationList {...props} />), click, props };
}

it("keeps small lists fully rendered with existing labels and native tab order", () => {
  const view = fixture(items.slice(0, 3));
  expect(view.container.querySelector(".project-navigation-scroll")).toBeNull();
  expect(view.getAllByRole("button")).toHaveLength(6);
  fireEvent.click(view.getByRole("button", { name: "Fact 2" })); expect(view.click).toHaveBeenCalledWith(items[2]);
});

it("bounds mounted rows, exposes full position/extent and reaches distant records with End/Home", async () => {
  const view = fixture();
  const list = view.getByRole("list", { name: "Graph" });
  expect(view.getAllByRole("listitem").length).toBeLessThan(25);
  expect(view.getAllByRole("listitem")[0]).toHaveAttribute("aria-setsize", "1000");
  expect(list.firstElementChild).toHaveStyle({ height: "24000px" });
  act(() => view.getByRole("button", { name: "Fact 0" }).focus());
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  await waitFor(() => expect(view.getByRole("button", { name: "Fact 999" })).toHaveFocus());
  fireEvent.click(document.activeElement!); expect(view.click).toHaveBeenCalledWith(items[999]);
  expect(view.getAllByRole("listitem").length).toBeLessThan(25);
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  await waitFor(() => expect(view.getByRole("button", { name: "Fact 0" })).toHaveFocus());
});

it("preserves row actions with arrows/pages and bridges Tab across an unmounted boundary", async () => {
  const view = fixture();
  act(() => view.getByRole("button", { name: "Action 0" }).focus());
  fireEvent.keyDown(document.activeElement!, { key: "PageDown" });
  await waitFor(() => expect(view.getByRole("button", { name: "Action 12" })).toHaveFocus());
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  await waitFor(() => expect(view.getByRole("button", { name: "Action 13" })).toHaveFocus());
  const rows = view.getAllByRole("listitem");
  const last = rows.at(-1)!;
  const index = Number(last.getAttribute("data-nav-index"));
  act(() => last.querySelectorAll("button")[1]!.focus());
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  await waitFor(() => expect(view.getByRole("button", { name: `Fact ${index + 1}` })).toHaveFocus());
});

it("pins one focused row during scrolling and releases it when focus leaves", async () => {
  const view = fixture(), list = view.getByRole("list", { name: "Graph" });
  act(() => view.getByRole("button", { name: "Fact 0" }).focus());
  fireEvent.scroll(list, { target: { scrollTop: 12000 } });
  expect(view.getByRole("button", { name: "Fact 0" })).toHaveFocus();
  expect(view.getAllByRole("listitem").length).toBeLessThan(26);
  fireEvent.blur(document.activeElement!, { relatedTarget: document.body });
  await waitFor(() => expect(view.queryByRole("button", { name: "Fact 0" })).toBeNull());
});

it("observes replacement titles/callbacks, language labels and shrinking lists", () => {
  const view = fixture();
  const replacement = items.map((item, i) => i ? item : { ...item, title: "Updated" });
  const onClick = vi.fn();
  view.rerender(<ProjectNavigationList {...view.props} items={replacement} label="Граф" renderItem={(item) => <button onClick={() => onClick(item)}>{item.title}</button>} />);
  expect(view.getByRole("list", { name: "Граф" })).toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Updated" })); expect(onClick).toHaveBeenCalledWith(replacement[0]);
  view.rerender(<ProjectNavigationList {...view.props} items={replacement.slice(0, 2)} />);
  expect(view.queryByRole("list")).toBeNull(); expect(view.getAllByRole("button")).toHaveLength(4);
});

it("retains a surviving focused button across the small/virtual threshold", async () => {
  const view = fixture(items.slice(0, 80));
  act(() => view.getByRole("button", { name: "Fact 0" }).focus());
  view.rerender(<ProjectNavigationList {...view.props} items={items.slice(0, 81)} />);
  await waitFor(() => expect(view.getByRole("button", { name: "Fact 0" })).toHaveFocus());
  view.rerender(<ProjectNavigationList {...view.props} items={items.slice(0, 80)} />);
  expect(view.getByRole("button", { name: "Fact 0" })).toHaveFocus();
});
