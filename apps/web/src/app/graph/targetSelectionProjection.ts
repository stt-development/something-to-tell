type Selectable = { id: string; selectable?: boolean };

/** Transient public permissions only: preserve canonical flags, every row and geometry. */
export function projectTargetSelectable<T extends Selectable>(rows: T[] | undefined, id: string | null, prevent: boolean) {
  if (!id) return { rows, known: true };
  let index = -1;
  for (let current = 0; current < (rows?.length ?? 0); current++) {
    if (rows![current]!.id !== id) continue;
    if (index !== -1) return { rows, known: false };
    index = current;
  }
  if (index === -1) return { rows, known: false };
  const row = rows![index]!;
  // Explicit true/false retain the library's existing per-element precedence.
  if (!prevent || row.selectable !== undefined) return { rows, known: true };
  const projected = rows!.slice();
  projected[index] = { ...row, selectable: false };
  return { rows: projected, known: true };
}
