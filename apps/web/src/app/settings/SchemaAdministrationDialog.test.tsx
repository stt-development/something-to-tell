/** UI review state never owns SQL, retries or durable schema plans. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteSchemaPlanV1, RemoteStorageInspectionV1 } from "@something-to-tell/contracts/remote-storage";
import { applyProjectLocale, tr } from "../../localization/i18n";
import type { RuntimeSchemaAdministration } from "../../runtime/schemaAdministrationClient";
import { RuntimeApiError } from "../../runtime/transport";
import { SchemaAdministrationDialog } from "./SchemaAdministrationDialog";

const profile = { profile_id: "admin", label: "DBA", host: "localhost", port: 5432, database: "review", username: "operator", tls_policy: "verify-full" as const };
const inspection: RemoteStorageInspectionV1 = { protocol_version: 1, server_major: 17, schema_status: "older", schema_revision: "v9",
  tls_policy: "verify-full", tls_active: true, identity_verified: true, privileges: "administrator" };
const plan: RemoteSchemaPlanV1 = { protocol_version: 1, plan_id: "review-id", plan_fingerprint: "fingerprint", action: "upgrade",
  source_schema_revision: "v9", target_schema_revision: "v11", migration_revisions: ["v10", "v11"], expires_at: "2026-11-06T16:00:00Z", backup_required: true };
function client() {
  return { listProfiles: vi.fn().mockResolvedValue({ profiles: [profile] }), addProfile: vi.fn().mockResolvedValue({ ...profile, profile_id: "new" }),
    inspect: vi.fn().mockResolvedValue(inspection), prepare: vi.fn().mockResolvedValue(plan),
    attest: vi.fn().mockResolvedValue({ backup_attestation_id: "ack" }),
    execute: vi.fn().mockResolvedValue({ protocol_version: 1, plan_id: plan.plan_id, action: plan.action, schema_revision: "v11", status: "completed" }) } satisfies RuntimeSchemaAdministration;
}
async function inspectAndReview() {
  await waitFor(() => expect(screen.getByLabelText(tr("storageAdmin.profile"))).toBeEnabled());
  fireEvent.change(screen.getByLabelText(tr("storageAdmin.profile")), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: tr("storageAdmin.inspect") }));
  await waitFor(() => expect(screen.getByRole("button", { name: tr("storageAdmin.review") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: tr("storageAdmin.review") }));
  await screen.findByRole("button", { name: tr("storageAdmin.execute") });
}
function consent() { for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox); }
beforeEach(async () => { await applyProjectLocale("en"); });
afterEach(async () => { await applyProjectLocale("en"); });

it("loads summaries without auto-selecting, inspecting, opening or executing", async () => {
  const api = client();
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("Administrator connection")).toBeEnabled());
  expect(screen.getByLabelText("Administrator connection")).toHaveValue("");
  expect(api.listProfiles).toHaveBeenCalledWith("/tmp/a.narrative");
  expect(api.inspect).not.toHaveBeenCalled(); expect(api.execute).not.toHaveBeenCalled();
});

it("requires whole-database and backup consent, then executes the reviewed identity once", async () => {
  const api = client();
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await inspectAndReview();
  const execute = screen.getByRole("button", { name: "Apply reviewed changes" });
  expect(screen.getByText("v10")).toBeInTheDocument(); expect(execute).toBeDisabled();
  fireEvent.click(screen.getAllByRole("checkbox")[0]!); expect(execute).toBeDisabled();
  fireEvent.click(screen.getAllByRole("checkbox")[1]!); fireEvent.click(execute); fireEvent.click(execute);
  await screen.findByText("Schema v11 applied.");
  expect(api.attest).toHaveBeenCalledWith(expect.objectContaining({ project_path: "/tmp/a.narrative", profile_id: "admin", plan_id: plan.plan_id, plan_fingerprint: plan.plan_fingerprint }));
  expect(api.execute).toHaveBeenCalledTimes(1);
  expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ backup_attestation_id: "ack" }), plan);
  expect(screen.queryByRole("button", { name: "Apply reviewed changes" })).not.toBeInTheDocument();
});

it("provisions an empty schema without inventing a backup attestation", async () => {
  const api = client(); api.inspect.mockResolvedValue({ ...inspection, schema_status: "empty", schema_revision: null });
  const provision = { ...plan, action: "provision" as const, source_schema_revision: null, backup_required: false };
  api.prepare.mockResolvedValue(provision);
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await inspectAndReview(); expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  consent(); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  await screen.findByText("Schema v11 applied.");
  expect(api.attest).not.toHaveBeenCalled();
  expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ backup_attestation_id: null }), provision);
});

it("drops a failed execution plan and requires inspection instead of replay", async () => {
  const api = client(); api.execute.mockRejectedValue(new RuntimeApiError("remote_commit_unknown", "unknown", 503));
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await inspectAndReview(); consent(); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  await screen.findByRole("alert");
  expect(screen.getByText(tr("storageAdmin.inspectBeforeRetry"))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply reviewed changes" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
  expect(api.execute).toHaveBeenCalledTimes(1);
});

it("blocks dismissal only during mutation, while permitting cancellation of reads", async () => {
  const api = client(), onClose = vi.fn(); let finish!: (value: Awaited<ReturnType<RuntimeSchemaAdministration["execute"]>>) => void;
  api.execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={onClose} />);
  await inspectAndReview(); consent(); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: tr("common.closeDialog") })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish({ protocol_version: 1, plan_id: plan.plan_id, action: "upgrade", schema_revision: "v11", status: "completed" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(onClose).toHaveBeenCalledTimes(1);
});

it("ignores stale profile reads when the folder changes and allows read dismissal", async () => {
  const api = client(), onClose = vi.fn(); let finish!: (value: { profiles: typeof profile[] }) => void;
  api.listProfiles.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<SchemaAdministrationDialog projectPath="/tmp/old.narrative" persistence={api} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(onClose).toHaveBeenCalledTimes(1);
  view.rerender(<SchemaAdministrationDialog projectPath="/tmp/new.narrative" persistence={api} onClose={onClose} />);
  await screen.findByRole("option", { name: "DBA · operator" });
  await act(async () => finish({ profiles: [{ ...profile, label: "Stale" }] }));
  expect(screen.queryByRole("option", { name: /Stale/ })).not.toBeInTheDocument();
});

it("configures a folder-scoped encrypted profile without Open or automatic inspection", async () => {
  const api = client(); render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: tr("storage.addConnection") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: tr("storage.addConnection") }));
  for (const [key, value] of [["connectionName", "New admin"], ["database", "review"], ["username", "operator"], ["password", "secret"]]) {
    fireEvent.change(screen.getByLabelText(tr(`storage.${key}` as "storage.database")), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: tr("storage.addConnection") }));
  await waitFor(() => expect(screen.getByLabelText("Administrator connection")).toHaveValue("new"));
  expect(api.addProfile).toHaveBeenCalledWith(expect.objectContaining({ protocol_version: 1, project_path: "/tmp/a.narrative", password: "secret" }));
  expect(api.inspect).not.toHaveBeenCalled();
});

it("keeps execution unavailable for the currently open remote project", async () => {
  const api = client(); render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} remoteProjectOpen onClose={vi.fn()} />);
  await inspectAndReview(); consent();
  expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled(); expect(screen.getByRole("note")).toBeInTheDocument();
});

it("renders the review lifecycle in Russian", async () => {
  await applyProjectLocale("ru"); const api = client();
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await inspectAndReview();
  expect(screen.getByRole("heading", { name: "Схема базы данных" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Применить изменения" })).toBeDisabled();
  expect(screen.queryByText(/storageAdmin\./)).not.toBeInTheDocument();
});

it.each(["current", "future", "unknown", "partial"] as const)("does not prepare changes for %s schemas", async status => {
  const api = client(); api.inspect.mockResolvedValue({ ...inspection, schema_status: status });
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("Administrator connection")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Administrator connection"), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect schema" }));
  await screen.findByText(tr(`storageAdmin.schema.${status}`), { exact: false });
  expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled(); expect(api.prepare).not.toHaveBeenCalled();
});

it("requires fresh inspection after a stale preparation failure", async () => {
  const api = client(); api.prepare.mockRejectedValue(new RuntimeApiError("remote_schema_plan_stale", "stale", 409));
  render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("Administrator connection")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Administrator connection"), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect schema" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Review changes" })); await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Inspect schema" })).toBeEnabled();
});

it("does not publish an old folder's delayed inspection into the new review", async () => {
  const api = client(); let finish!: (value: RemoteStorageInspectionV1) => void;
  api.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<SchemaAdministrationDialog projectPath="/tmp/a.narrative" persistence={api} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("Administrator connection")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Administrator connection"), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect schema" }));
  view.rerender(<SchemaAdministrationDialog projectPath="/tmp/b.narrative" persistence={api} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("Administrator connection")).toBeEnabled());
  await act(async () => finish(inspection));
  expect(screen.getByLabelText("Administrator connection")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
});
