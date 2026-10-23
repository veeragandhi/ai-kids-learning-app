/** store/ask.ts — per-child Ask/Explore sessions (local-first). */
import { createChildScopedStore } from "./localStore";
import { newRecordId, type AskSession } from "./types";

export type { AskSession };

const sessions = createChildScopedStore<AskSession>(
  "amigosnest-ask",
  "sessions",
  "amigosnest-ask-sessions-fallback"
);

export async function saveAskSession(
  input: Omit<AskSession, "id" | "at"> & { id?: string; at?: number }
): Promise<AskSession> {
  if (!input.childId) throw new Error("saveAskSession() requires childId");
  return sessions.save({
    ...input,
    id: input.id ?? newRecordId("ask"),
    at: input.at ?? Date.now(),
  });
}

export async function listAskSessions(childId: string): Promise<AskSession[]> {
  return sessions.listFor(childId);
}

export async function deleteAskSessionsForChild(childId: string): Promise<void> {
  return sessions.deleteAllFor(childId);
}
