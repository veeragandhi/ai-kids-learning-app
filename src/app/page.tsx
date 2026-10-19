"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLearner } from "@/contexts/LearnerContext";
import { resolveActiveChildId } from "@/lib/store/activeChild";

export default function LearnPage() {
  // useSearchParams needs a Suspense boundary for static prerendering.
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-b from-sky-50 to-white flex items-center justify-center">
          <p className="text-gray-600 text-xl">Loading... 👋</p>
        </div>
      }
    >
      <LearnContent />
    </Suspense>
  );
}

function LearnContent() {
  const { learner } = useLearner();
  const searchParams = useSearchParams();

  // "Learn as Ira" lands here as /?age=<age>&childId=<id>. The URL age wins
  // when valid (3-18); otherwise fall back to the active learner's age.
  // The childId param is an untrusted hint (server + stores re-verify); it is
  // carried into topic links so a deep-linked session keeps its context.
  const urlAge = Number(searchParams.get("age"));
  const validUrlAge =
    Number.isInteger(urlAge) && urlAge >= 3 && urlAge <= 18 ? urlAge : null;
  const age = validUrlAge ?? learner?.age ?? null;
  const childId = resolveActiveChildId(learner?.id, searchParams.get("childId"));
  const childParam = `childId=${encodeURIComponent(childId)}`;

  const topics = [
    {
      name: "Plants",
      emoji: "🌱",
      color:
        "from-green-100 to-green-200",
    },
    {
      name: "Animals",
      emoji: "🦁",
      color:
        "from-yellow-100 to-orange-100",
    },
    {
      name: "Numbers",
      emoji: "🔢",
      color:
        "from-blue-100 to-blue-200",
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-white">
      {/* Hero */}
      <div className="text-center mt-8 px-6">

        <h1 className="text-5xl font-extrabold text-gray-800">
          {learner ? `Hi ${learner.nickname} 👋` : "Hi Explorer 👋"}
        </h1>

        <p className="text-gray-600 text-xl mt-4">
          {learner
            ? `What would you like to learn today, ${learner.nickname}?`
            : "What would you like to learn today?"}
        </p>
        {age !== null && (
          <p className="text-gray-500 text-sm mt-2">
            Showing fun topics picked for age {age}
          </p>
        )}
      </div>

      {/* Mascot */}
      <div className="max-w-xl mx-auto mt-10 px-6">

        <div className="bg-white rounded-3xl shadow-lg p-8 text-center">

          <div className="text-7xl mb-4">
            🦉
          </div>

          <h2 className="text-3xl font-bold text-gray-800">
            Meet AmigosNest!
          </h2>

          <p className="text-gray-600 mt-2">
            Your AI learning buddy
          </p>
        </div>
      </div>

      {/* Topics */}
      <div className="max-w-6xl mx-auto mt-14 px-6">

        <h2 className="text-3xl font-bold text-gray-800 mb-6">
          📚 Learning Topics
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">

          {topics.map((topic) => (
            <Link
              key={topic.name}
              href={`/lesson?topic=${topic.name.toLowerCase()}&${childParam}`}
              className={`
                bg-gradient-to-br
                ${topic.color}
                cursor-pointer
                rounded-3xl
                p-8
                shadow-lg
                hover:scale-105
                hover:shadow-xl
                transition-all
                block
              `}
            >
              <div className="text-6xl mb-4">
                {topic.emoji}
              </div>

              <h3 className="text-2xl font-bold text-gray-800">
                {topic.name}
              </h3>

              <p className="text-gray-700 mt-3">
                Tap to explore fun facts
                about {topic.name.toLowerCase()}
              </p>
            </Link>
          ))}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="max-w-4xl mx-auto mt-16 px-6">

        <h2 className="text-3xl font-bold text-gray-800 mb-6 text-center">
          🚀 Start Learning
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

          <Link
            href={`/lesson?${childParam}`}
            className="bg-blue-500 text-white p-6 rounded-3xl shadow-lg hover:bg-blue-600 transition block"
          >
            <div className="text-4xl mb-2">
              🎓
            </div>

            <div className="text-xl font-bold">
              Start Learning
            </div>
          </Link>

          <Link
            href={`/quiz?${childParam}`}
            className="bg-green-500 text-white p-6 rounded-3xl shadow-lg hover:bg-green-600 transition block"
          >
            <div className="text-4xl mb-2">
              🎮
            </div>

            <div className="text-xl font-bold">
              Fun Quiz
            </div>
          </Link>

          <Link
            href={`/ask?${childParam}`}
            className="bg-purple-500 text-white p-6 rounded-3xl shadow-lg hover:bg-purple-600 transition block"
          >
            <div className="text-4xl mb-2">
              🔍
            </div>

            <div className="text-xl font-bold">
              Explore
            </div>

            <div className="text-sm text-white/90 mt-1">
              Ask anything, beyond your lessons
            </div>
          </Link>
        </div>
      </div>

      {/* Featured Section */}
      <div className="max-w-4xl mx-auto mt-16 px-6 mb-20">

        <div className="bg-yellow-100 rounded-3xl p-8 shadow-lg">

          <h2 className="text-3xl font-bold text-gray-800">
            🌟 Today&apos;s Adventure
          </h2>

          <p className="text-gray-600 mt-4 text-lg">
            Learn through stories,
            quizzes and fun
            conversations with your AI
            buddy!
          </p>

          <Link
            href={`/lesson?${childParam}`}
            className="inline-block bg-purple-500 text-white px-8 py-4 rounded-full mt-6 text-xl font-bold hover:bg-purple-600 transition"
          >
            Start Adventure 🚀
          </Link>
        </div>
      </div>
    </div>
  );
}
