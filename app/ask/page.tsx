"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type AskStage = "ask" | "guided" | "answer" | "done";

type AskResponse = {
  type?: string;
  answer?: string;
  question?: string;
  hintLevel?: number;
  questionType?: string;
  correctness?: string;
  feedback?: string;
  nextPrompt?: string;
  score?: number;
  finalPrompt?: string;
  retry?: boolean;
  responseState?: string;
  continueLearning?: boolean;
  source?: string;
  _timing?: { totalTime: number; retrievalTime: number; llmTime: number };
  conversation?: ConversationTurn[];
};

type ConversationTurn = {
  role: "child" | "assistant";
  content: string;
};

export default function AskPage() {
  return (
    <Suspense fallback={<div />}>
      <AskInner />
    </Suspense>
  );
}

function AskInner() {
  const searchParams = useSearchParams();
  const [stage, setStage] = useState<AskStage>("ask");
  const [question, setQuestion] = useState("");
  // URL params and the sessionStorage lesson handoff are client-only:
  // reading them during render mismatches the server prerender (no
  // sessionStorage, empty search params) and throws a hydration error.
  // Start from server-matching defaults, then sync in an effect.
  const [age, setAge] = useState(8);
  const [questionType, setQuestionType] = useState<"guided" | "creative">("guided");
  const [guidingQuestion, setGuidingQuestion] = useState("");
  const [studentAnswer, setStudentAnswer] = useState("");
  const [lastStudentAnswer, setLastStudentAnswer] = useState("");
  const [explanation, setExplanation] = useState("");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  // Lesson-linked Ask: when arriving from /lesson, the displayed lesson is
  // the grounding context (same sessionStorage handoff as Quiz).
  const [{ lessonTopic, lessonText }, setLessonRef] = useState({
    lessonTopic: "",
    lessonText: "",
  });

  useEffect(() => {
    const ageParam = Number(searchParams.get("age"));
    if (Number.isFinite(ageParam) && ageParam >= 3 && ageParam <= 18) {
      setAge(Math.floor(ageParam));
    }
    if (searchParams.get("source") !== "lesson") return;
    const topic = searchParams.get("topic") || "";
    try {
      const raw = sessionStorage.getItem("lastLesson");
      if (raw) {
        const last = JSON.parse(raw);
        if (
          last &&
          typeof last.lesson === "string" &&
          typeof last.topic === "string" &&
          (!topic || last.topic.trim().toLowerCase() === topic.trim().toLowerCase())
        ) {
          setLessonRef({ lessonTopic: last.topic, lessonText: last.lesson.slice(0, 2000) });
        }
      }
    } catch {
      // storage unavailable: fall back to standalone document Q&A
    }
  }, [searchParams]);

  const lessonSourcePayload =
    lessonText && lessonTopic
      ? { source: "lesson" as const, lessonText, lessonTopic }
      : { source: "standalone" as const };

  const reset = () => {
    setStage("ask");
    setGuidingQuestion("");
    setStudentAnswer("");
    setLastStudentAnswer("");
    setExplanation("");
    setResponse(null);
    setConversation([]);
    setError("");
  };

  // Honest no-context answer (e.g. lesson-linked "I don't know based on
  // this lesson"): the answer lives in the conversation history while we
  // stay in the "ask" stage, so clear the input for the next question
  // without wiping the history or lesson context.
  const askAnotherAfterHonestAnswer = () => {
    setQuestion("");
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
        body: JSON.stringify({ question, age, mode: "question", questionType, conversation, ...lessonSourcePayload }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to get a guiding question.");
        return;
      }
      // Honest no-context shape (e.g. the lesson cannot answer the
      // question): show the message in the conversation and stay here.
      if (data.answer && !data.question) {
        setConversation(data.conversation || []);
        setResponse(data);
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
      setConversation(data.conversation || []);
      setStage("guided");
    } catch {
      setError("Network error while asking the question.");
    } finally {
      setLoading(false);
    }
  };

  const submitAnswer = async () => {
    if (!studentAnswer.trim()) return;
    const submittedAnswer = studentAnswer.trim();
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
          studentAnswer: submittedAnswer,
          conversation,
          ...lessonSourcePayload,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to evaluate your answer.");
        return;
      }
      setResponse(data);
      setConversation(data.conversation || []);
      setLastStudentAnswer(submittedAnswer);
      setStudentAnswer("");
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
          studentAnswer: lastStudentAnswer,
          explanation,
          conversation,
          ...lessonSourcePayload,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to evaluate your explanation.");
        return;
      }
      setResponse(data);
      setConversation(data.conversation || []);
      setStage(data.retry ? "answer" : "done");
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
            {lessonText && lessonTopic && (
              <p className="mt-3 inline-block rounded-full bg-green-100 px-4 py-2 text-sm font-semibold text-green-700">
                Asking about your lesson on {lessonTopic} 📚
              </p>
            )}
          </div>

          {stage === "ask" && (
            <div className="space-y-6">
              <div>
                <label className="text-sm font-semibold text-slate-700">Your Question</label>
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={4}
                  className="mt-2 w-full rounded-3xl border border-slate-200 bg-white p-4 text-slate-900 shadow-sm placeholder:text-slate-400 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
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
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white p-3 text-slate-900 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
                  />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Question style
                  <select
                    value={questionType}
                    onChange={(e) => setQuestionType(e.target.value as "guided" | "creative")}
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white p-3 text-slate-900 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
                  >
                    <option value="guided">Guided thinking question</option>
                    <option value="creative">Invent your own example</option>
                  </select>
                </label>
              </div>

              <button
                onClick={askQuestion}
                disabled={loading || !question.trim()}
                className="inline-flex items-center justify-center rounded-3xl bg-indigo-600 px-6 py-3 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
              >
                {loading ? "Thinking..." : "Get a guiding question"}
              </button>
            </div>
          )}

          {conversation.length > 0 && (
            <section className="mt-8 border-t border-slate-200 pt-6" aria-label="Conversation history">
              <h2 className="text-lg font-semibold text-slate-900">Conversation</h2>
              <div className="mt-4 space-y-3">
                {conversation.map((turn, index) => (
                  <div
                    key={`${turn.role}-${index}`}
                    className={`rounded-2xl p-4 ${
                      turn.role === "child" ? "ml-8 bg-indigo-50 text-indigo-950" : "mr-8 bg-slate-50 text-slate-800"
                    }`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {turn.role === "child" ? "Child" : "AmigosNest"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{turn.content}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {stage === "ask" && response?.answer && !error && (
            <div className="mt-8 rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Want to keep exploring?</h2>
              <p className="mt-2 text-slate-700">
                {lessonTopic
                  ? `That question goes beyond your lesson on ${lessonTopic}. Ask another question about what the lesson teaches.`
                  : "Ask another question from your learning material."}
              </p>
              <button
                onClick={askAnotherAfterHonestAnswer}
                className="mt-4 inline-flex items-center justify-center rounded-3xl bg-indigo-600 px-6 py-3 text-white transition hover:bg-indigo-700"
              >
                {lessonTopic ? "Ask another question about this lesson" : "Ask another question"}
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
                <p className="mt-6 text-sm text-slate-500">
                  Hint level: {response?.hintLevel || 1}
                </p>
              )}

              {stage === "guided" && (
                <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Your answer</h2>
                  <textarea
                    value={studentAnswer}
                    onChange={(e) => setStudentAnswer(e.target.value)}
                    rows={4}
                    className="mt-3 w-full rounded-3xl border border-slate-200 bg-white p-4 text-slate-900 placeholder:text-slate-400 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
                    placeholder="Write your answer here..."
                  />
                  <button
                    onClick={submitAnswer}
                    disabled={loading || !studentAnswer.trim()}
                    className="mt-4 inline-flex items-center justify-center rounded-3xl bg-emerald-600 px-6 py-3 text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                  >
                    {loading ? "Checking..." : "Submit answer"}
                  </button>
                </div>
              )}

              {stage === "answer" && response?.continueLearning && (
                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Keep thinking</h2>
                  <p className="mt-3 whitespace-pre-line text-slate-700">{response.nextPrompt}</p>
                  <textarea
                    value={studentAnswer}
                    onChange={(e) => setStudentAnswer(e.target.value)}
                    rows={4}
                    className="mt-4 w-full rounded-3xl border border-slate-200 bg-white p-4 text-slate-900 placeholder:text-slate-400 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
                    placeholder="Tell me what you think in your own words."
                  />
                  <button
                    onClick={submitAnswer}
                    disabled={loading || !studentAnswer.trim()}
                    className="mt-4 inline-flex items-center justify-center rounded-3xl bg-emerald-600 px-6 py-3 text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                  >
                    {loading ? "Thinking..." : "Try again"}
                  </button>
                </div>
              )}

              {stage === "answer" && response && !response.continueLearning && (
                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Explain your thinking</h2>
                  <div className="mt-6">
                    <textarea
                      value={explanation}
                      onChange={(e) => setExplanation(e.target.value)}
                      rows={4}
                      className="w-full rounded-3xl border border-slate-200 bg-white p-4 text-slate-900 placeholder:text-slate-400 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
                      placeholder="Explain how you knew your answer."
                    />
                    <button
                      onClick={submitExplanation}
                      disabled={loading || !explanation.trim()}
                      className="mt-4 inline-flex items-center justify-center rounded-3xl bg-blue-600 px-6 py-3 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                    >
                      {loading ? "Reviewing..." : "Submit explanation"}
                    </button>
                  </div>
                </div>
              )}

              {stage === "done" && response && (
                <div className="rounded-[28px] border border-slate-200 bg-emerald-50 p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Conversation complete</h2>
                  <p className="mt-3 text-slate-600">Explanation score: {response.score ?? 0}/100</p>
                  <p className="mt-3 text-slate-700">Your explanation and AmigosNest feedback are above.</p>
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
