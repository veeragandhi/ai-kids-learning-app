/** store/progress.ts — per-child concept progress (local-first). */
import { createChildScopedStore } from "./localStore";
import { newRecordId, type ProgressEntry } from "./types";

export type { ProgressEntry };

const entries = createChildScopedStore<ProgressEntry>(
  "amigosnest-progress",
  "entries",
  "amigosnest-progress-fallback"
);

export async function saveProgress(
  input: Omit<ProgressEntry, "id" | "at"> & { id?: string; at?: number }
): Promise<ProgressEntry> {
  if (!input.childId) throw new Error("saveProgress() requires childId");
  return entries.save({
    ...input,
    id: input.id ?? newRecordId("progress"),
    at: input.at ?? Date.now(),
  });
}

export async function listProgress(childId: string): Promise<ProgressEntry[]> {
  return entries.listFor(childId);
}

export async function deleteProgressForChild(childId: string): Promise<void> {
  return entries.deleteAllFor(childId);
}
