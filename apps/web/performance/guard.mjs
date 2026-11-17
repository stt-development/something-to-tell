import { spawn } from "node:child_process";

/** Kill only this disposable worker's process group if browser JS stops yielding. */
export function guardedWorker(executable, args, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_baseline_timeout");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? "guard_exceeded" : code === 0 ? "ok" : "failed", exit_code: code });
    });
  });
}
