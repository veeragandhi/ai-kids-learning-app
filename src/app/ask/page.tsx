"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  getActiveLessonId,
  getLesson,
  resolveActiveChildId,
  resolveLocalChildId,
  saveAskSession,
  lastLessonKey } from "@/lib/store";
import { useLearner } from "@/contexts/LearnerContext";
import { apiFetch } from "@/lib/supabase/authedFetch";
import VoiceTextarea from "@/components/VoiceTextarea";

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

// In-progress Ask draft (local-first, localStorage only): leaving /ask to
// re-read the lesson and coming back resumes instead of restarting. Scoped
// per child + lesson scope so profiles and lessons never share drafts.
type AskDraft = {
  v: 1;
  question: string;
  guidingQuestion: string;
  lastStudentAnswer: string;
  stage: AskStage;
  conversation: ConversationTurn[];
  attemptCount: number;
  age: number;
  response: AskResponse | null;
};

function askDraftScope(
  params: { lessonId: string | null; source: string | null; topic: string },
  localChildId: string
): string {
  if (params.lessonId) return `lesson:${params.lessonId}`;
  if (params.source === "lesson") {
    const active = getActiveLessonId(localChildId);
    if (active) return `lesson:${active}`;
    if (params.topic.trim()) return `topic:${params.topic.trim().toLowerCase()}`;
    return "lesson";
  }
  return "standalone";
}

function askDraftKey(localChildId: string, scope: string): string {
  return `ask-draft:${localChildId}:${scope}`;
}

export default function AskPage() {
  return (
    <Suspense fallback={<div />}>
      <AskInner />
    </Suspense>
  );
}

function AskInner() {
  const searchParams = useSearchParams();
  const { learner, hydrated } = useLearner();
  const childId = resolveActiveChildId(
    learner?.id,
    searchParams.get("childId")
  );
  const localChildId = resolveLocalChildId(learner?.id);
  const [stage, setStage] = useState<AskStage>("ask");
  const [question, setQuestion] = useState("");
  // URL params and the sessionStorage lesson handoff are client-only:
  // reading them during render mismatches the server prerender (no
  // sessionStorage, empty search params) and throws a hydration error.
  // Start from server-matching defaults, then sync in an effect.
  const [age, setAge] = useState(8);
  // Guided attempts on the current question (sent as attemptCount so the
  // server can trigger the STUCK escape hatch at 3+ unlanding attempts).
  // Reset whenever a new question starts.
  const [attemptCount, setAttemptCount] = useState(0);
  const [guidingQuestion, setGuidingQuestion] = useState("");
  const [studentAnswer, setStudentAnswer] = useState("");
  const [lastStudentAnswer, setLastStudentAnswer] = useState("");
  const [explanation, setExplanation] = useState("");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  // True when the current state was restored from a saved draft (shows a
  // "resumed" note so the child knows nothing was lost). Cleared on the
  // next question/answer/reset.
  const [resumed, setResumed] = useState(false);
  const [speakingTurn, setSpeakingTurn] = useState<number | null>(null);
  const speechUtterance = useRef<SpeechSynthesisUtterance | null>(null);
  // Lesson-linked Ask: when arriving from /lesson, the displayed lesson is
  // the grounding context (same sessionStorage handoff as Quiz).
  const [{ lessonTopic, lessonText }, setLessonRef] = useState({
    lessonTopic: "",
    lessonText: "",
  });

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const toggleReplySpeech = (index: number, text: string) => {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      !("SpeechSynthesisUtterance" in window)
    ) {
      setError("Audio playback is not available in this browser.");
      return;
    }
    const synthesis = window.speechSynthesis;
    if (speakingTurn === index) {
      synthesis.cancel();
      speechUtterance.current = null;
      setSpeakingTurn(null);
      return;
    }

    synthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = synthesis.getVoices();
    let preferredName: string | null = null;
    try {
      preferredName = localStorage.getItem("amigosnest-voice");
    } catch {
      // Use the browser's default voice when local storage is unavailable.
    }
    utterance.voice =
      voices.find((voice) => voice.name === preferredName) ??
      voices.find((voice) => (voice.lang || "").toLowerCase().startsWith("en")) ??
      null;
    utterance.rate = 0.95;
    utterance.pitch = 1.2;
    utterance.volume = 1;
    utterance.onstart = () => setSpeakingTurn(index);
    utterance.onend = () => {
      if (speechUtterance.current === utterance) {
        speechUtterance.current = null;
        setSpeakingTurn(null);
      }
    };
    utterance.onerror = () => {
      if (speechUtterance.current === utterance) {
        speechUtterance.current = null;
        setSpeakingTurn(null);
        setError("Audio playback could not start. Please try again.");
      }
    };
    speechUtterance.current = utterance;
    synthesis.speak(utterance);
  };

  // Draft scope for this visit (stable per child + lesson context).
  const draftScope = useMemo(
    () =>
      askDraftScope(
        {
          lessonId: searchParams.get("lessonId"),
          source: searchParams.get("source"),
          topic: searchParams.get("topic") || "",
        },
        localChildId
      ),
    [searchParams, localChildId]
  );
  const draftKey = useMemo(() => askDraftKey(localChildId, draftScope), [localChildId, draftScope]);
  // Gate for the save effect below: on a fresh page load the save effect
  // runs synchronously while state is still pristine — before the deferred
  // restore microtask reads the draft. Without this gate the pristine
  // cleanup deletes the saved draft before restore ever sees it. Tracks
  // the key restore last ran for, so a scope switch never saves the old
  // scope's state under the new scope's key either.
  const restoredForKey = useRef<string | null>(null);

  // Legacy sessionStorage handoff (pre-IndexedDB flow). Kept so older
  // /lesson links without ?lessonId= still ground Ask in the lesson.
  const fallBackToSessionHandoff = useCallback((topic: string) => {
    try {
      const raw = sessionStorage.getItem(lastLessonKey(localChildId));
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
  }, [localChildId]);

  useEffect(() => {
    // Wait for learner hydration (see ClientLesson): the first pass must not
    // ground Ask in another profile's lesson text.
    if (!hydrated) return;
    const ageParam = Number(searchParams.get("age"));
    const explicitId = searchParams.get("lessonId");
    const topic = searchParams.get("topic") || "";
    const idToLoad =
      explicitId ||
      (searchParams.get("source") === "lesson" ? getActiveLessonId(localChildId) : null);
    const fromLesson = searchParams.get("source") === "lesson";
    // Client-only hydration (URL params + sessionStorage) runs deferred by a
    // microtask so the first render still matches the server prerender.
    void Promise.resolve().then(() => {
      if (Number.isFinite(ageParam) && ageParam >= 3 && ageParam <= 18) {
        setAge(Math.floor(ageParam));
      }
      if (!idToLoad && fromLesson) {
        fallBackToSessionHandoff(topic);
      }
      // TEMP-DIAG: remove once draft persistence is confirmed working.
      console.log("[ask-draft] restore attempt", draftKey);
      // Resume an in-progress conversation for this child + lesson scope
      // (e.g. the child went back to re-read the lesson). An explicit age
      // in the URL still wins over the saved one. When switching to a
      // scope with no draft, start fresh instead of showing the old
      // scope's thread.
      const isScopeSwitch = restoredForKey.current !== null && restoredForKey.current !== draftKey;
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const draft = JSON.parse(raw) as AskDraft;
          if (
            draft &&
            draft.v === 1 &&
            ((Array.isArray(draft.conversation) && draft.conversation.length > 0) ||
              (typeof draft.question === "string" && draft.question.trim()) ||
              (typeof draft.guidingQuestion === "string" && draft.guidingQuestion.trim()))
          ) {
            setQuestion(typeof draft.question === "string" ? draft.question : "");
            setGuidingQuestion(typeof draft.guidingQuestion === "string" ? draft.guidingQuestion : "");
            setLastStudentAnswer(typeof draft.lastStudentAnswer === "string" ? draft.lastStudentAnswer : "");
            setStage(draft.stage === "guided" || draft.stage === "answer" || draft.stage === "done" ? draft.stage : "ask");
            setConversation(Array.isArray(draft.conversation) ? draft.conversation : []);
            setAttemptCount(
              Number.isFinite(draft.attemptCount)
                ? Math.max(0, Math.min(10, Math.floor(draft.attemptCount)))
                : 0
            );
            if (!(Number.isFinite(ageParam) && ageParam >= 3 && ageParam <= 18) && typeof draft.age === "number") {
              setAge(Math.max(3, Math.min(18, Math.floor(draft.age))));
            }
            setResponse(draft.response ?? null);
            setResumed(true);
            // TEMP-DIAG: remove once draft persistence is confirmed working.
            console.log("[ask-draft] restored", draft.conversation?.length ?? 0, "turns");
          } else if (isScopeSwitch) {
            setQuestion("");
            setGuidingQuestion("");
            setLastStudentAnswer("");
            setResponse(null);
            setConversation([]);
            setAttemptCount(0);
            setResumed(false);
            setStage("ask");
          }
        } else if (isScopeSwitch) {
          setQuestion("");
          setGuidingQuestion("");
          setLastStudentAnswer("");
          setResponse(null);
          setConversation([]);
          setAttemptCount(0);
          setResumed(false);
          setStage("ask");
        }
      } catch {
        // storage unavailable or corrupt draft: start fresh
      } finally {
        restoredForKey.current = draftKey;
      }
    });
    // Lesson-linked Ask: same persisted lesson as /lesson (IndexedDB),
    // so Ask reuses the exact lesson content. sessionStorage handoff kept
    // as a legacy fallback. An explicit ?lessonId= always wins; the
    // active-lesson pointer is only used for lesson-sourced visits so a
    // standalone /ask stay standalone. Ownership-checked: a sibling's
    // lessonId yields no grounding (honest unknown), never foreign text.
    if (idToLoad) {
      getLesson(idToLoad, localChildId)
        .then((saved) => {
          if (saved && (!topic || saved.topic.trim().toLowerCase() === topic.trim().toLowerCase())) {
            setLessonRef({ lessonTopic: saved.topic, lessonText: saved.lesson.slice(0, 2000) });
            return;
          }
          fallBackToSessionHandoff(topic);
        })
        .catch(() => fallBackToSessionHandoff(topic));
      return;
    }
    if (searchParams.get("source") !== "lesson") return;
  }, [searchParams, childId, localChildId, hydrated, fallBackToSessionHandoff, draftKey]);

  // Persist the in-progress conversation for this child + lesson scope
  // (best-effort, localStorage only). Gated on restore having run for this
  // key: otherwise the synchronous first run sees pristine defaults and
  // deletes the draft before restore reads it. A pristine page clears any
  // stale draft so a finished question never resurrects.
  useEffect(() => {
    // TEMP-DIAG: remove once draft persistence is confirmed working.
    if (!hydrated || restoredForKey.current !== draftKey) {
      console.log("[ask-draft] save skipped", { hydrated, gated: restoredForKey.current !== draftKey, draftKey });
      return;
    }
    try {
      const pristine =
        stage === "ask" && conversation.length === 0 && !question.trim() && !guidingQuestion;
      if (pristine) {
        localStorage.removeItem(draftKey);
        return;
      }
      const draft: AskDraft = {
        v: 1,
        question,
        guidingQuestion,
        lastStudentAnswer,
        stage,
        conversation: conversation.slice(-30),
        attemptCount,
        age,
        response,
      };
      localStorage.setItem(draftKey, JSON.stringify(draft));
      // TEMP-DIAG: remove once draft persistence is confirmed working.
      console.log("[ask-draft] saved", draftKey, draft.conversation.length, "turns");
    } catch {
      // storage unavailable: conversation simply won't resume
    }
  }, [hydrated, draftKey, stage, question, guidingQuestion, lastStudentAnswer, conversation, attemptCount, age, response]);

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
    setAttemptCount(0);
    setResumed(false);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // best-effort
    }
  };

  // Honest no-context answer (e.g. lesson-linked "I don't know based on
  // this lesson"): the answer lives in the conversation history while we
  // stay in the "ask" stage, so clear the input for the next question
  // without wiping the history or lesson context.
  const askAnotherAfterHonestAnswer = () => {
    setQuestion("");
    setResponse(null);
    setError("");
    setAttemptCount(0);
  };

  const askQuestion = async () => {
    if (!question.trim()) return;
    setLoading(true);
    setError("");
    setAttemptCount(0);
    setResumed(false);

    try {
      const res = await apiFetch("/api/ask", {
        method: "POST",
        body: { question, age, mode: "question", questionType: "guided", conversation, childId, ...lessonSourcePayload },
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        // Auth failure: never fall back to another child's namespace.
        setError("Please ask a parent to sign in and select this child's profile, then try again.");
        return;
      }
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
    const nextAttempt = attemptCount + 1;
    setAttemptCount(nextAttempt);
    setLoading(true);
    setError("");
    setResumed(false);

    try {
      const res = await apiFetch("/api/ask", {
        method: "POST",
        body: {
          question,
          age,
          mode: "answer",
          guidingQuestion,
          studentAnswer: submittedAnswer,
          attemptCount: nextAttempt,
          conversation,
          childId,
          ...lessonSourcePayload,
        },
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
    setResumed(false);

    try {
      const res = await apiFetch("/api/ask", {
        method: "POST",
        body: {
          question,
          age,
          mode: "explanation",
          guidingQuestion,
          studentAnswer: lastStudentAnswer,
          explanation,
          attemptCount,
          conversation,
          childId,
          ...lessonSourcePayload,
        },
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Unable to evaluate your explanation.");
        return;
      }
      setResponse(data);
      setConversation(data.conversation || []);
      const done = !data.retry;
      setStage(done ? "done" : "answer");
      if (done) {
        // The completed session is archived per-child; the in-progress
        // draft is done and must not resurrect on the next visit.
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // best-effort
        }
        // Per-child history (best-effort, never blocks the UI).
        saveAskSession({
          childId: localChildId,
          lessonId: searchParams.get("lessonId"),
          question,
          turns: (data.conversation as { role: "child" | "assistant"; content: string }[]) || [],
        }).catch(() => {
          // persistence is best-effort
        });
      }
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
            {resumed && conversation.length > 0 && (
              <p className="mt-3 inline-block rounded-full bg-indigo-100 px-4 py-2 text-sm font-semibold text-indigo-700">
                Welcome back — your conversation is right where you left it 👍
              </p>
            )}
          </div>

          {/* Completed conversation sits ABOVE the current step so the
              child always sees what was already said before typing next. */}
          {conversation.length > 0 && (
            <section className="mb-8 border-b border-slate-200 pb-6" aria-label="Conversation history">
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
                    {turn.role === "assistant" && (
                      <button
                        type="button"
                        onClick={() => toggleReplySpeech(index, turn.content)}
                        className="mt-3 inline-flex items-center rounded-full bg-violet-100 px-3 py-1.5 text-sm font-semibold text-violet-800 transition hover:bg-violet-200 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2"
                        aria-label={`${speakingTurn === index ? "Stop listening to" : "Listen to"} AmigosNest reply`}
                      >
                        {speakingTurn === index ? "Stop listening" : "Listen"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {stage === "ask" && (
            <div className="space-y-6">
              <div>
                <label className="text-sm font-semibold text-slate-700">Your Question</label>
                <VoiceTextarea
                  value={question}
                  onChange={setQuestion}
                  rows={4}
                  ariaLabel="Your question"
                  className="mt-2 w-full rounded-3xl border border-slate-200 bg-white p-4 text-slate-900 shadow-sm placeholder:text-slate-400 [color-scheme:light] focus:border-indigo-400 focus:outline-none"
                  placeholder="What do you want to learn from your document?"
                />
              </div>

              <div>
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
                <div className="mt-6 flex items-center justify-between gap-3">
                  <p className="text-sm text-slate-500">
                    Hint level: {response?.hintLevel || 1}
                  </p>
                  {(stage === "guided" || stage === "answer") && (
                    <button
                      onClick={reset}
                      className="rounded-full px-4 py-2 text-sm font-semibold text-indigo-600 transition hover:bg-indigo-50 hover:text-indigo-800"
                    >
                      ↩ Ask a different question
                    </button>
                  )}
                </div>
              )}

              {stage === "guided" && (
                <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Your answer</h2>
                  <VoiceTextarea
                    value={studentAnswer}
                    onChange={setStudentAnswer}
                    rows={4}
                    ariaLabel="Your answer"
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
                  <VoiceTextarea
                    value={studentAnswer}
                    onChange={setStudentAnswer}
                    rows={4}
                    ariaLabel="Your answer"
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
                    <VoiceTextarea
                      value={explanation}
                      onChange={setExplanation}
                      rows={4}
                      ariaLabel="Your explanation"
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
