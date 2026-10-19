/**
 * store/activeChild.ts — resolve which child the UI acts as.
 *
 * Two resolvers (Stage 2 split — never collapse them):
 *
 * - `resolveRequestChildId(learnerId, urlChildId)`: the id sent to APIs.
 *   Priority: explicit active learner → `childId` URL hint → `demo-local`.
 *   The URL value is an UNTRUSTED navigation hint: the server re-verifies
 *   ownership on every personalized call, so a foreign hint yields 401/403,
 *   never sibling data.
 * - `resolveLocalChildId(learnerId)`: the ONLY id used for local-store
 *   reads/writes (IndexedDB + sessionStorage handoff). Active learner → else
 *   `demo-local`. The URL parameter is deliberately ignored here so changing
 *   `?childId=` can never authorize access to another child's local lessons,
 *   quizzes, Ask history, or progress.
 */

import { DEMO_CHILD_ID } from "@/lib/supabase/requireChild";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUsableChildId(value: unknown): value is string {
  return value === DEMO_CHILD_ID || (typeof value === "string" && UUID_RE.test(value.trim()));
}

export function resolveRequestChildId(
  learnerId: unknown,
  urlChildId: unknown
): string {
  if (typeof learnerId === "string" && learnerId.length > 0) return learnerId;
  if (isUsableChildId(urlChildId)) return (urlChildId as string).trim();
  return DEMO_CHILD_ID;
}

/** Backward-compatible alias for the request (API) resolver. */
export const resolveActiveChildId = resolveRequestChildId;

export function resolveLocalChildId(learnerId: unknown): string {
  if (typeof learnerId === "string" && learnerId.length > 0) return learnerId;
  return DEMO_CHILD_ID;
}

export function isDemoChild(childId: unknown): boolean {
  return childId === DEMO_CHILD_ID;
}
