export const DIALOGUE_CONTROLS_SUITE = "long_dialogue_controls_v1";

/** Inspect a real editor: text rows remain mounted while only inactive target options may shrink. */
export function observeDialogueControls() {
  const editor = document.querySelector(".dialogue-branch-editor");
  const selects = [...(editor?.querySelectorAll("select") ?? [])].filter((select) =>
    select.parentElement.querySelector(".dialogue-field-heading")?.textContent.trim() === "Next");
  return { rows: editor?.querySelectorAll("article[data-canon-owner-id]").length ?? 0,
    next_selectors: selects.length, next_options: selects.reduce((total, select) => total + select.options.length, 0),
    max_selector_options: Math.max(0, ...selects.map((select) => select.options.length)),
    text_fields: editor?.querySelectorAll("textarea").length ?? 0 };
}

export function verifyDialogueControls(value, observeOnly = false) {
  if (value.rows !== 200 || value.next_selectors < 200 || value.text_fields < 190 || value.next_options < value.next_selectors) throw Error("long_dialogue_controls_incomplete");
  if (!observeOnly && (value.next_options > value.next_selectors * 2 || value.max_selector_options > 2)) throw Error("long_dialogue_inactive_options_unbounded");
  return value;
}

export function verifyDialogueRegistryRequests(count) {
  // Two mount windows; an overlapping first read may still serve the second mount.
  if (!Number.isInteger(count) || count < 1 || count > 2) throw Error("long_dialogue_registry_requests_unbounded");
  return count;
}
