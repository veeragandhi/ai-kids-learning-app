"use client";

import Link from "next/link";

export default function LearnPage() {
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

      {/* Navbar */}
      <div className="flex justify-between items-center px-6 py-4">

        <div className="text-2xl font-bold text-gray-800">
          🌈 LearnBuddy
        </div>

        <Link
          href="/parent"
          className="bg-white shadow px-4 py-2 rounded-full hover:shadow-md"
        >
          👩 Parent Dashboard
        </Link>
      </div>

      {/* Hero */}
      <div className="text-center mt-8 px-6">

        <h1 className="text-5xl font-extrabold text-gray-800">
          Hi Explorer 👋
        </h1>

        <p className="text-gray-600 text-xl mt-4">
          What would you like to
          learn today?
        </p>
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
              href={`/lesson?topic=${topic.name.toLowerCase()}`}
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
            href="/lesson"
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
            href="/quiz"
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
            href="/ask"
            className="bg-purple-500 text-white p-6 rounded-3xl shadow-lg hover:bg-purple-600 transition block"
          >
            <div className="text-4xl mb-2">
              💬
            </div>

            <div className="text-xl font-bold">
              Ask AmigosNest
            </div>
          </Link>
        </div>
      </div>

      {/* Featured Section */}
      <div className="max-w-4xl mx-auto mt-16 px-6 mb-20">

        <div className="bg-yellow-100 rounded-3xl p-8 shadow-lg">

          <h2 className="text-3xl font-bold text-gray-800">
            🌟 Today's Adventure
          </h2>

          <p className="text-gray-700 mt-4 text-lg">
            Discover how lions roar
            to protect their family!
          </p>

          <Link
            href="/lesson?topic=animals"
            className="mt-6 bg-orange-500 text-white px-6 py-3 rounded-full shadow hover:bg-orange-600 inline-block"
          >
            Start Adventure
          </Link>
        </div>
      </div>
    </div>
  );
}