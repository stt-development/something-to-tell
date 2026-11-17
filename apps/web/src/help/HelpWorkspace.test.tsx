import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../localization/i18n";
import * as catalog from "./guideCatalog";
import { HelpWorkspace } from "./HelpWorkspace";

beforeEach(async () => { await applyProjectLocale("en"); });
afterEach(() => { vi.restoreAllMocks(); });

it("shows an article load error and retries without abandoning navigation", async () => {
  vi.spyOn(catalog, "loadGuide").mockRejectedValueOnce(new Error("missing chunk"));
  render(<HelpWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: /^Your first story/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This guide could not be loaded.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("heading", { name: "Your first story" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "All topics" }));
  expect(await screen.findByRole("button", { name: /^Export Identifiers/ })).toBeInTheDocument();
});

it("shows a localized search failure rather than an empty successful result", async () => {
  await applyProjectLocale("ru");
  vi.spyOn(catalog, "searchGuides").mockRejectedValueOnce(new Error("missing source"));
  render(<HelpWorkspace />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить это руководство.");
  fireEvent.click(screen.getByRole("button", { name: "Попробовать снова" }));
  expect(await screen.findByRole("button", { name: /^Первая история/ })).toBeInTheDocument();
});
