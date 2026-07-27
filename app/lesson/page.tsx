import React, { Suspense } from "react";
import ClientLesson from "./ClientLesson";

export default function LessonPage() {
  return (
    <Suspense fallback={<div />}>
      <ClientLesson />
    </Suspense>
  );
}
