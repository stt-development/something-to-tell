import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../localization/i18n";
import { GuideReader } from "./GuideReader";

beforeEach(async () => { await applyProjectLocale("en"); });

it("renders formatted prose, tables, code and heading navigation with stable ids", () => {
  const navigate = vi.fn();
  render(<GuideReader articleId="canvas" onNavigate={navigate} markdown={'# Canvas\n\n## Tools\n\n**Select** and *Pan* with `code`.\n\n| Key | Action |\n|---|---|\n| A | B |\n\n[Projects](projects.en.md#save)'} />);
  expect(screen.getByRole("heading", { name: "Tools" })).toHaveAttribute("id", "guide-tools");
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByText("Select").tagName).toBe("STRONG");
  expect(screen.getByText("code").tagName).toBe("CODE");
  fireEvent.click(screen.getByRole("link", { name: "Tools" }));
  expect(navigate).toHaveBeenCalledWith("canvas", "tools");
  fireEvent.click(screen.getByRole("link", { name: "Projects" }));
  expect(navigate).toHaveBeenCalledWith("projects", "save");
});

it("blocks executable HTML, dangerous links and remote/unbundled images", () => {
  const { container } = render(<GuideReader articleId="canvas" onNavigate={vi.fn()} markdown={'# Safety\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n[Bad](javascript:alert%281%29)\n\n[File](file:///tmp/private)\n\n![Remote](https://example.com/spy.png)'} />);
  expect(container.querySelector("script,iframe,img")).toBeNull();
  expect(container.querySelector('a[href^="javascript"],a[href^="file"]')).toBeNull();
  expect(screen.getByText(/Image unavailable/)).toBeInTheDocument();
});

it("does not navigate the app for an external link and localizes the copy action", async () => {
  await applyProjectLocale("ru");
  const navigate = vi.fn();
  render(<GuideReader articleId="canvas" onNavigate={navigate} markdown="[External](https://example.com/help)" />);
  expect(screen.getByRole("button", { name: "Скопировать внешнюю ссылку" })).toHaveAttribute("title", "https://example.com/help");
  expect(screen.queryByRole("link", { name: "External" })).not.toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
});

it("enlarges only packaged screenshots, closes the image before Help and handles broken images", () => {
  render(<GuideReader articleId="getting-started" onNavigate={vi.fn()} markdown="![Start menu](assets/getting-started/start.en.png)" />);
  const open = screen.getByRole("button", { name: "Enlarge image: Start menu" });
  fireEvent.click(open);
  const imageLayer = screen.getByRole("group", { name: "Start menu" });
  expect(screen.getByRole("button", { name: "Close image" })).toHaveFocus();
  fireEvent.keyDown(imageLayer, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "Start menu" })).not.toBeInTheDocument();
  expect(open).toHaveFocus();
  fireEvent.error(screen.getByRole("img", { name: "Start menu" }));
  expect(screen.getByText("Start menu: Image unavailable")).toBeInTheDocument();
});
