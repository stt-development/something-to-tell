export const PROJECT_NAVIGATION_SUITE = "project_navigation_rows_v1";

/** Count actual mounted navigation rows, never a capped canonical collection. */
export function observeProjectNavigation() {
  return [...document.querySelectorAll(".project-navigation-scroll")].map((list) => ({
    mounted: list.querySelectorAll('[role="listitem"]').length,
    total: Number(list.querySelector('[role="listitem"]')?.getAttribute("aria-setsize")),
    height: list.clientHeight, extent: list.scrollHeight,
    focused: list.contains(document.activeElement)
  }));
}

export function verifyProjectNavigation(rows) {
  if (!rows.length || rows.some((row) => row.total <= 80 || row.mounted < 1 || row.mounted > 25 || row.height !== 288 || row.extent <= row.height)) {
    throw new Error("project_navigation_rows_unbounded_or_incomplete");
  }
  return rows;
}

/** Horizontal containment applies to small member lists too, not just virtual rows. */
export function projectNavigationOverflow() {
  let overflow = 0;
  for (const list of document.querySelectorAll("[data-project-navigation]")) {
    const frame = list.getBoundingClientRect();
    for (const button of list.querySelectorAll("button")) {
      const bounds = button.getBoundingClientRect();
      if (bounds.width > 0 && (bounds.left < frame.left - 1 || bounds.right > frame.right + 1)) overflow++;
    }
  }
  return overflow;
}
