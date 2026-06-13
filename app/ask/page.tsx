"use client";

import { useState } from "react";

export default function AskPage() {
  const [q, setQ] = useState("");
  const [ans, setAns] = useState("");
  const [loading, setLoading] = useState(false);

  const ask = async () => {
    if (!q.trim()) return;

    setLoading(true);
    setAns("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: q }),
      });

      const data = await res.json();
      setAns(data.answer);
    } catch {
      setAns("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-blue-50 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl">
        <div className="bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-indigo-600 to-blue-600 p-8 text-white">
            <h1 className="text-3xl font-bold">Ask Milo</h1>
            <p className="mt-2 text-indigo-100">
              Ask questions about your uploaded learning material.
            </p>
          </div>

          {/* Content */}
          <div className="p-8">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Your Question
            </label>

            <textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="What would you like to learn today?"
              rows={4}
              className="w-full rounded-xl border border-gray-300 p-4 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />

            <button
              onClick={ask}
              disabled={loading || !q.trim()}
              className="mt-4 w-full sm:w-auto px-6 py-3 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg
                    className="animate-spin h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      opacity="0.25"
                    />
                    <path
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  Thinking...
                </span>
              ) : (
                "Ask Milo"
              )}
            </button>

            {/* Answer Section */}
            {(loading || ans) && (
              <div className="mt-8">
                <h2 className="text-lg font-semibold text-gray-800 mb-3">
                  Answer
                </h2>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
                  {loading ? (
                    <div className="space-y-3">
                      <div className="h-4 bg-gray-200 rounded animate-pulse" />
                      <div className="h-4 bg-gray-200 rounded animate-pulse w-5/6" />
                      <div className="h-4 bg-gray-200 rounded animate-pulse w-4/6" />
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-gray-700 leading-7">
                      {ans}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}