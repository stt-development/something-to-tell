/** Transient native-close handshake; project actions retain Save/Discard ownership. */
import { useEffect, useLayoutEffect, useRef } from "react";

type CloseHandler = (requestId: number) => Promise<void> | void;
let handler: CloseHandler | null = null;

export function registerNativeCloseHandler(next: CloseHandler): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

export async function resolveNativeClose(requestId: number, approve: boolean): Promise<void> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error("desktop_close_unavailable");
  await invoke("resolve_native_close", { requestId, approve });
}

export async function requestNativeProjectClose(requestId: number): Promise<void> {
  // No workspace handler means startup/empty-project UI, with no acquired session.
  if (handler) await handler(requestId);
  else await resolveNativeClose(requestId, true);
}

/** Sequential native IPC polling avoids event-plugin grants and overlapping calls. */
export function useNativeCloseRequests(onRequest: CloseHandler, interval = 250, onPending?: (id: number | null) => void) {
  const callback = useRef(onRequest);
  const observe = useRef(onPending);
  useLayoutEffect(() => { callback.current = onRequest; observe.current = onPending; }, [onRequest, onPending]);
  useEffect(() => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    let disposed = false;
    let seen: number | null = null;
    let timer: ReturnType<typeof setTimeout>;
    async function inspect() {
      try {
        const id = await invoke!("native_close_request");
        const valid = typeof id === "number" && Number.isInteger(id) && id > 0 && id <= 0xffffffff;
        if (!disposed && (id === null || valid)) observe.current?.(id as number | null);
        if (!disposed && valid && id !== seen) {
          seen = id;
          await callback.current(id);
        }
      } catch { /* IPC failure cannot authorize close or clear a project session. */ }
      if (!disposed) timer = setTimeout(() => void inspect(), interval);
    }
    timer = setTimeout(() => void inspect(), interval);
    return () => { disposed = true; clearTimeout(timer); };
  }, [interval]);
}
