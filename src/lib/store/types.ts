/**
 * store/types.ts — per-child learning-record shapes (local-first, V1).
 *
 * Every record carries `childId` (Supabase `children.id` UUID or `demo-local`).
 * `childId: null` never appears on new records — it only backfills legacy
 * rows so read paths can treat them as read-only, never as grounding context.
 */

export type ChildId = string;

export interface QuizAttempt {
  id: string;
  childId: ChildId;
  lessonId: string | null;
  topic: string;
  score: number;
  total: number;
  age: number;
  at: number;
}

export interface AskTurn {
  role: "child" | "assistant";
  content: string;
}

export interface AskSession {
  id: string;
  childId: ChildId;
  lessonId: string | null;
  question: string;
  turns: AskTurn[];
  at: number;
}

export interface ProgressEntry {
  id: string;
  childId: ChildId;
  concept: string;
  attempts: number;
  correct: number;
  at: number;
}

export function newRecordId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
