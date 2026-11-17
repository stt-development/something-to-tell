import { useGraphStore } from "../../state/graphStore";

/** Displays canonical error prose without subscribing the canvas owner to it. */
export function ProjectSaveError() {
  const error = useGraphStore((state) => state.activeProjectSession?.save_error ?? null);
  return error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null;
}
