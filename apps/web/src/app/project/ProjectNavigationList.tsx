import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

interface NavigationListProps<T> {
  items: readonly T[];
  className?: string;
  itemKey: (item: T) => string;
  label: string;
  rowHeight: number;
  renderItem: (item: T) => ReactNode;
}

/** One row owner across the threshold: small lists keep native layout and no scroll subscription. */
export function ProjectNavigationList<T>({ items, itemKey, label, rowHeight, renderItem, className }: NavigationListProps<T>) {
  const virtual = items.length > 80;
  const scroll = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [pending, setPending] = useState<{ key: string; action: number } | null>(null);
  const indices = useMemo(() => new Map(items.map((item, index) => [itemKey(item), index])), [items, itemKey]);
  const focusedIndex = focusedKey === null ? undefined : indices.get(focusedKey);
  const getItemKey = useCallback((index: number) => itemKey(items[index]!), [items, itemKey]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const visible = defaultRangeExtractor(range);
    // A focused/dragged row must not unmount merely because the user scrolls away.
    if (focusedIndex !== undefined && !visible.includes(focusedIndex)) visible.push(focusedIndex);
    return visible.sort((a, b) => a - b);
  }, [focusedIndex]);
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight, getItemKey, rangeExtractor, overscan: 4,
    initialRect: { width: 224, height: 288 }, enabled: virtual, useFlushSync: false });
  const rows = virtual ? virtualizer.getVirtualItems() : items.map((item, index) => ({ key: itemKey(item), index, start: 0 }));

  useLayoutEffect(() => {
    if (!pending) return;
    const index = indices.get(pending.key);
    const buttons = scroll.current?.querySelector(`[data-nav-index="${index}"]`)?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (buttons?.length) {
      buttons[Math.min(pending.action, buttons.length - 1)]!.focus({ preventScroll: true });
      setPending(null);
    }
  }, [pending, indices, rows]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!virtual) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-nav-index]");
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(row.dataset.navIndex);
    const buttons = [...row.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const action = Math.max(0, buttons.indexOf(target.closest("button")!));
    let next = index, nextAction = action;
    if (event.key === "ArrowDown") next++;
    else if (event.key === "ArrowUp") next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "PageDown") next += Math.max(1, Math.floor(288 / rowHeight));
    else if (event.key === "PageUp") next -= Math.max(1, Math.floor(288 / rowHeight));
    else if (event.key === "Tab" && ((event.shiftKey && action === 0) || (!event.shiftKey && action === buttons.length - 1))) {
      next += event.shiftKey ? -1 : 1;
      if (next < 0 || next >= items.length || scroll.current?.querySelector(`[data-nav-index="${next}"]`)) return;
      nextAction = event.shiftKey ? Number.MAX_SAFE_INTEGER : 0;
    } else return;
    next = Math.max(0, Math.min(items.length - 1, next));
    event.preventDefault();
    const key = getItemKey(next);
    setFocusedKey(key); setPending({ key, action: nextAction });
    virtualizer.scrollToIndex(next, { align: "auto" });
  }

  return <div aria-label={label} className={virtual ? "project-navigation-scroll" : "min-w-0"} data-project-navigation ref={scroll} role={virtual ? "list" : undefined}
    onKeyDown={navigate} onFocusCapture={(event) => {
      const index = (event.target as HTMLElement).closest<HTMLElement>("[data-nav-index]")?.dataset.navIndex;
      if (index !== undefined) setFocusedKey(getItemKey(Number(index)));
    }} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setFocusedKey(null);
    }} onDragStartCapture={(event) => {
      const index = (event.target as HTMLElement).closest<HTMLElement>("[data-nav-index]")?.dataset.navIndex;
      if (index !== undefined) setFocusedKey(getItemKey(Number(index)));
    }} onDragEndCapture={() => {
      if (!scroll.current?.contains(document.activeElement)) setFocusedKey(null);
    }}>
    <div className={virtual ? undefined : `${className ?? "grid gap-1"} min-w-0`} style={virtual ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined}>
      {rows.map((row) => <div aria-posinset={virtual ? row.index + 1 : undefined} aria-setsize={virtual ? items.length : undefined} data-nav-index={row.index}
        className="min-w-0" key={row.key} role={virtual ? "listitem" : undefined} style={virtual ? { position: "absolute", top: 0, left: 0, width: "100%", height: rowHeight,
          transform: `translateY(${row.start}px)` } : undefined}>
        {renderItem(items[row.index]!)}
      </div>)}
    </div>
  </div>;
}
