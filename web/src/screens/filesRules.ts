// Pure Files screen rules. The screen calls these; tests call them directly.

export function selectionAfterQuery<T>(selected: Set<T>, previousQuery: string, nextQuery: string): Set<T> {
  if (previousQuery === nextQuery) return selected;
  return new Set();
}

export type BatchKind = "trash" | "delete" | "restore";

// Null means no success toast: every call failed, and the error toast stands alone.
export function batchToast(succeeded: number, failed: number, kind: BatchKind): string | null {
  if (succeeded <= 0) return null;
  const total = succeeded + failed;
  if (failed > 0) {
    if (kind === "trash") return `${succeeded} of ${total} moved to Trash`;
    if (kind === "delete") return `Deleted ${succeeded} of ${total}`;
    return `Restored ${succeeded} of ${total}`;
  }
  if (kind === "delete") return "Deleted";
  if (kind === "trash") return succeeded === 1 ? "Moved to Trash" : `${succeeded} items moved to Trash`;
  return succeeded === 1 ? "Restored" : `${succeeded} items restored`;
}

// Download is one regular file. A folder or several paths would be a zip, which is not served.
export function offersDownload(items: readonly { directory: boolean }[]): boolean {
  return items.length === 1 && items[0].directory === false;
}

export function actionsForItems<T extends { id: string }>(
  actions: readonly T[],
  items: readonly { directory: boolean }[],
): T[] {
  if (offersDownload(items)) return [...actions];
  return actions.filter((a) => a.id !== "download" && a.id !== "download-zip");
}
