import { deleteAskSessionsForChild } from "./ask";
import { deleteLessonsForChild } from "./lessons";
import { deleteProgressForChild } from "./progress";
import { deleteQuizAttemptsForChild } from "./quizzes";

/** Remove this child's local-first lesson content and learning history. */
export async function deleteChildLearningData(childId: string): Promise<void> {
  if (!childId) throw new Error("deleteChildLearningData() requires childId");

  await Promise.all([
    deleteLessonsForChild(childId),
    deleteQuizAttemptsForChild(childId),
    deleteAskSessionsForChild(childId),
    deleteProgressForChild(childId),
  ]);

  const draftPrefix = `ask-draft:${childId}:`;
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith(draftPrefix)) localStorage.removeItem(key);
  }
  sessionStorage.removeItem(`lastLesson:${childId}`);
}
