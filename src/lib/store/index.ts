/**
 * store/index.ts — the ONLY data-access entrypoint for UI code.
 * Pages must import from `@/lib/store`, never `lessonStorage`/`vectorStore`
 * directly, so ownership checks cannot be skipped by accident.
 */
export * from "./types";
export * from "./activeChild";
export * from "./lessons";
export * from "./quizzes";
export * from "./ask";
export * from "./progress";
