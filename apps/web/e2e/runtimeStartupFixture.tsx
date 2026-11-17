/** Vite-only browser fixture: real bootstrap/startup component, no API or user projects. */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { applyProjectLocale } from "../src/localization/i18n";
import { connectRuntime } from "../src/runtime/runtimeBootstrap";
import { configuredRuntimeBaseUrl } from "../src/runtime/runtimeConnection";
import { RuntimeStartup } from "../src/startup/RuntimeStartup";
import "../src/styles.css";

const parameters = new URLSearchParams(location.search);
const scenario = parameters.get("scenario") ?? "ready";
await applyProjectLocale(parameters.get("locale") === "ru" ? "ru" : "en");
let attempts = 0;
let mounted = 0;
let closeResolved = false;
if (scenario === "lost-close") window.__TAURI_INTERNALS__ = { invoke: async (command, payload) => {
  if (command === "native_close_request") return mounted && Date.now() - mounted > 3200 && !closeResolved ? 1 : null;
  if (command === "resolve_native_close") {
    closeResolved = true;
    document.body.dataset.closeDecision = String(payload?.approve);
    return null;
  }
  throw new Error("unexpected fixture command");
} };

function Editor() {
  const [keys, setKeys] = useState(0);
  useEffect(() => {
    mounted = Date.now();
    const count = () => setKeys(value => value + 1);
    window.addEventListener("keydown", count);
    return () => window.removeEventListener("keydown", count);
  }, []);
  return <main style={{ padding: 24 }}>
    <h1>Editor fixture</h1>
    <label>Draft<input aria-label="Draft" defaultValue="Unsaved draft" /></label>
    <output data-testid="fixture-keys">{keys}</output>
    <output data-testid="fixture-base">{configuredRuntimeBaseUrl()}</output>
    {createPortal(<aside data-testid="fixture-portal" style={{ position: "fixed", top: 8, right: 8, zIndex: 2147483647 }}>Portal overlay</aside>, document.body)}
  </main>;
}

const connect = () => connectRuntime({ desktop: true, development: false, invoke: async command => {
  if (command !== "start_bundled_runtime") throw new Error("unexpected fixture command");
  attempts += 1;
  await new Promise(resolve => setTimeout(resolve, scenario === "pending" ? 1200 : 300));
  if (scenario === "failed" && attempts === 1) throw new Error("private fixture error");
  return { origin: "http://127.0.0.1:51234", token: "A".repeat(43) }; // Deliberately fake.
} });

createRoot(document.getElementById("root")!).render(<RuntimeStartup
  connect={connect} loadApplication={async () => ({ App: Editor })}
  isRunning={async () => !scenario.startsWith("lost") || Date.now() - mounted < 2500} pollInterval={100}
/>);
