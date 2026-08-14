"use client";

import { useState } from "react";

type AskStage = "ask" | "guided" | "answer" | "done";

type AskResponse = {
  type?: string;
  question?: string;
  hintLevel?: number;
  questionType?: string;
  correctness?: string;
  feedback?: string;
  nextPrompt?: string;
  score?: number;
  finalPrompt?: string;
  source?: string;
  _timing?: { totalTime: number; retrievalTime: number; llmTime: number };
};

export default function AskPage() {
  const [stage, setStage] = useState<AskStage>("ask");
  const [question, setQuestion] = useState("");
  const [age, setAge] = useState(8);
  const [questionType, setQuestionType] = useState<"guided" | "creative">("guided");
  const [guidingQuestion, setGuidingQuestion] = useState("");
  const [studentAnswer, setStudentAnswer] = useState("");
  const [explanation, setExplanation] = useState("");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setStage("ask");
    setGuidingQuestion("");
    setStudentAnswer("");
    setExplanation("");
    setResponse(null);
    setError("");
  };

  const askQuestion = async () => {
    if (!question.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, age, mode: "question", questionType }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to get a guiding question.");
        return;
      }
      const isGuidingQuestionResponse =
        data.type === "guidingQuestion" ||
        data.type === "guiddingQuestion" ||
        Boolean(data.question);

      if (!isGuidingQuestionResponse || !data.question) {
        setError("The assistant did not return a guiding question. Please try again.");
        return;
      }
      setGuidingQuestion(data.question);
      setResponse(data);
      setStage("guided");
    } catch {
      setError("Network error while asking the question.");
    } finally {
      setLoading(false);
    }
  };

  const submitAnswer = async () => {
    if (!studentAnswer.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          age,
          mode: "answer",
          guidingQuestion,
          studentAnswer,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to evaluate your answer.");
        return;
      }
      setResponse(data);
      setStage("answer");
    } catch {
      setError("Network error while submitting the answer.");
    } finally {
      setLoading(false);
    }
  };

  const submitExplanation = async () => {
    if (!explanation.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          age,
          mode: "explanation",
          guidingQuestion,
          studentAnswer,
          explanation,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to evaluate your explanation.");
        return;
      }
      setResponse(data);
      setStage("done");
    } catch {
      setError("Network error while submitting the explanation.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-blue-50 p-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-xl">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-slate-900">Ask AmigosNest</h1>
            <p className="mt-2 text-slate-600">
              Ask a question about your uploaded document and follow the Socratic steps.
            </p>
          </div>

          {stage === "ask" && (
            <div className="space-y-6">
              <div>
                <label className="text-sm font-semibold text-slate-700">Your Question</label>
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={4}
                  className="mt-2 w-full rounded-3xl border border-slate-200 p-4 text-slate-800 shadow-sm focus:border-indigo-400 focus:outline-none"
                  placeholder="What do you want to learn from your document?"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold text-slate-700">
                  Child age
                  <input
                    type="number"
                    min={5}
                    max={12}
                    value={age}
                    onChange={(e) => setAge(Number(e.target.value))}
                    className="mt-2 w-full rounded-2xl border border-slate-200 p-3 text-slate-800 focus:border-indigo-400 focus:outline-none"
                  />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Question style
                  <select
                    value={questionType}
                    onChange={(e) => setQuestionType(e.target.value as "guided" | "creative")}
                    className="mt-2 w-full rounded-2xl border border-slate-200 p-3 text-slate-800 focus:border-indigo-400 focus:outline-none"
                  >
                    <option value="guided">Guided thinking question</option>
                    <option value="creative">Invent your own example</option>
                  </select>
                </label>
              </div>

              <button
                onClick={askQuestion}
                disabled={loading || !question.trim()}
                className="inline-flex items-center justify-center rounded-3xl bg-indigo-600 px-6 py-3 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {loading ? "Thinking..." : "Get a guiding question"}
              </button>
            </div>
          )}

          {(stage !== "ask" || error) && (
            <div className="mt-8 space-y-6">
              {error && (
                <div className="rounded-3xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {error}
                </div>
              )}

              {guidingQuestion && stage !== "ask" && (
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <h2 className="text-xl font-semibold text-slate-900">Guiding Question</h2>
                  <p className="mt-3 text-slate-700">{guidingQuestion}</p>
                  {stage === "guided" ? (
                    <p className="mt-3 text-sm text-slate-500">
                      This is step 1 of the Socratic flow. Answer it first, and then the app will give you feedback and a second prompt.
                    </p>
                  ) : (
                    <p className="mt-3 text-sm text-slate-500">
                      Hint level: {response?.hintLevel || 1}
                    </p>
                  )}
                </div>
              )}

              {stage === "guided" && (
                <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Your answer</h2>
                  <textarea
                    value={studentAnswer}
                    onChange={(e) => setStudentAnswer(e.target.value)}
                    rows={4}
                    className="mt-3 w-full rounded-3xl border border-slate-200 p-4 text-slate-800 focus:border-indigo-400 focus:outline-none"
                    placeholder="Write your answer here..."
                  />
                  <button
                    onClick={submitAnswer}
                    disabled={loading || !studentAnswer.trim()}
                    className="mt-4 inline-flex items-center justify-center rounded-3xl bg-emerald-600 px-6 py-3 text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {loading ? "Checking..." : "Submit answer"}
                  </button>
                </div>
              )}

              {stage === "answer" && response && (
                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Feedback</h2>
                  <p className="mt-3 text-slate-800">{response.feedback}</p>
                  <p className="mt-4 text-sm text-slate-600">Next: {response.nextPrompt || "How did you know?"}</p>

                  <div className="mt-6">
                    <textarea
                      value={explanation}
                      onChange={(e) => setExplanation(e.target.value)}
                      rows={4}
                      className="w-full rounded-3xl border border-slate-200 p-4 text-slate-800 focus:border-indigo-400 focus:outline-none"
                      placeholder="Explain how you knew your answer."
                    />
                    <button
                      onClick={submitExplanation}
                      disabled={loading || !explanation.trim()}
                      className="mt-4 inline-flex items-center justify-center rounded-3xl bg-blue-600 px-6 py-3 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {loading ? "Reviewing..." : "Submit explanation"}
                    </button>
                  </div>
                </div>
              )}

              {stage === "done" && response && (
                <div className="rounded-[28px] border border-slate-200 bg-emerald-50 p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Explanation Feedback</h2>
                  <p className="mt-3 text-slate-800">{response.feedback}</p>
                  <p className="mt-2 text-slate-600">Score: {response.score ?? 0}/100</p>
                  <p className="mt-4 text-slate-700">{response.finalPrompt}</p>
                  <button
                    onClick={reset}
                    className="mt-6 inline-flex items-center justify-center rounded-3xl bg-indigo-600 px-6 py-3 text-white transition hover:bg-indigo-700"
                  >
                    Ask another question
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
