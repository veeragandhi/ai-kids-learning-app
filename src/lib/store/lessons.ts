/**
 * store/lessons.ts — per-child lesson access. The ONLY lesson entrypoint for
 * pages (do not import `lessonStorage` directly in UI code).
 *
 * - `saveLesson({childId, ...})` requires the active owner (never inferred).
 * - `getLesson(id, childId)` / `listLessons(childId)` enforce ownership.
 * - Legacy (`childId: null`) records are listed separately as read-only and
 *   are never returned as grounding context; `importLegacyLesson()` copies one
 *   into the child's namespace under a new id (original untouched).
 */
import {
  lessonStorage,
  type SaveLessonInput,
  type StoredLesson,
} from "@/lib/lessonStorage";

export type { StoredLesson };

export async function saveLesson(
  input: SaveLessonInput & { childId: string }
): Promise<StoredLesson> {
  if (!input.childId) throw new Error("saveLesson() requires childId");
  return lessonStorage.save(input);
}

export async function getLesson(
  id: string,
  childId: string
): Promise<StoredLesson | null> {
  if (!id || !childId) return null;
  return lessonStorage.getOwned(id, childId);
}

export async function listLessons(childId: string): Promise<StoredLesson[]> {
  if (!childId) return [];
  return lessonStorage.listFor(childId);
}

export async function listLegacyLessons(): Promise<StoredLesson[]> {
  return lessonStorage.listLegacy();
}

export async function deleteLesson(id: string, childId: string): Promise<void> {
  if (!id || !childId) return;
  return lessonStorage.deleteOwned(id, childId);
}

/** Copy a legacy lesson into the child's namespace (new id, original kept). */
export async function importLegacyLesson(
  id: string,
  childId: string
): Promise<StoredLesson | null> {
  if (!id || !childId) return null;
  const legacy = await lessonStorage.get(id);
  if (!legacy || legacy.childId !== null) return null;
  return lessonStorage.save({
    topic: legacy.topic,
    title: legacy.title,
    lesson: legacy.lesson,
    age: legacy.age,
    childId,
    sourceDocumentId: legacy.sourceDocumentId,
    sourceDocumentName: legacy.sourceDocumentName,
  });
}

export function getActiveLessonId(childId?: string | null): string | null {
  return lessonStorage.getActiveId(childId);
}

export function setActiveLessonId(id: string | null, childId?: string | null): void {
  lessonStorage.setActiveId(id, childId);
}

/**
 * Per-child sessionStorage handoff key (quiz/Ask lesson anchoring). Scoping
 * the key stops Child B from inheriting Child A's in-memory lesson text
 * after a profile switch in the same tab.
 */
export function lastLessonKey(childId: string): string {
  return `lastLesson:${childId}`;
}
