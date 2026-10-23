/** store/quizzes.ts — per-child quiz attempts (local-first). */
import { createChildScopedStore } from "./localStore";
import { newRecordId, type QuizAttempt } from "./types";

export type { QuizAttempt };

const attempts = createChildScopedStore<QuizAttempt>(
  "amigosnest-quizzes",
  "attempts",
  "amigosnest-quiz-attempts-fallback"
);

export async function saveQuizAttempt(
  input: Omit<QuizAttempt, "id" | "at"> & { id?: string; at?: number }
): Promise<QuizAttempt> {
  if (!input.childId) throw new Error("saveQuizAttempt() requires childId");
  return attempts.save({
    ...input,
    id: input.id ?? newRecordId("quiz"),
    at: input.at ?? Date.now(),
  });
}

export async function getQuizAttempt(
  id: string,
  childId: string
): Promise<QuizAttempt | null> {
  return attempts.getOwned(id, childId);
}

export async function listQuizAttempts(childId: string): Promise<QuizAttempt[]> {
  return attempts.listFor(childId);
}

export async function deleteQuizAttemptsForChild(childId: string): Promise<void> {
  return attempts.deleteAllFor(childId);
}
