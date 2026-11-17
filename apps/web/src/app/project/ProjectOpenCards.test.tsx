import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { ProjectOpenCards } from "./ProjectOpenCards";

const projects = ["First", "Second"].map((name) => ({ name, path: `/tmp/${name}.narrative`,
  project_id: name.toLowerCase(), description: "Example", format_version: 2, updated_at: "2026-10-24T00:00:00Z" }));

afterEach(async () => { await applyProjectLocale("en"); });

it("launches folder administration independently of opening the project", () => {
  const onOpen = vi.fn(), onAdminister = vi.fn();
  render(<ProjectOpenCards projects={projects} onOpen={onOpen} onAdminister={onAdminister} onError={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Database schema" })[0]!);
  expect(onAdminister).toHaveBeenCalledWith(projects[0]!.path);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /First/ })).toBeEnabled();
});

it("keeps one indeterminate bar pending and blocks duplicate/concurrent opens", async () => {
  let complete!: () => void;
  const onOpen = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  render(<ProjectOpenCards projects={projects} onOpen={onOpen} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  const progress = screen.getByRole("progressbar", { name: "Opening First..." });
  expect(progress).not.toHaveAttribute("aria-valuenow");
  expect(progress.closest("button")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: /Second/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  fireEvent.click(screen.getByRole("button", { name: /Second/ }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  await act(async () => complete());
  await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: /Second/ })).toBeEnabled();
});

it("clears rejected progress, reports the error and allows retry", async () => {
  const onError = vi.fn();
  const onOpen = vi.fn().mockRejectedValueOnce(new Error("Open failed")).mockResolvedValueOnce(undefined);
  render(<ProjectOpenCards projects={projects} onOpen={onOpen} onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Open failed"));
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
});

it("localizes the pending card's accessible name in Russian", async () => {
  await applyProjectLocale("ru");
  render(<ProjectOpenCards projects={projects} onOpen={() => new Promise<void>(() => {})} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  expect(screen.getByRole("progressbar", { name: "Открытие First..." })).toBeInTheDocument();
});
