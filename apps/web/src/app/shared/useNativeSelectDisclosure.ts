import { useState } from "react";
import { flushSync } from "react-dom";

/** Shared native-popup ordering only; domains retain labels, eligibility and draft commands. */
export function useNativeSelectDisclosure(enabled: boolean) {
  const [expanded, setExpanded] = useState(false);
  const materialize = () => {
    // Native popup defaults read options before the next asynchronous React paint.
    if (enabled && !expanded) flushSync(() => setExpanded(true));
  };
  return { expanded, onPointerDownCapture: materialize, onKeyDownCapture: materialize,
    onFocus: () => { if (enabled) setExpanded(true); }, onBlur: () => setExpanded(false) };
}
