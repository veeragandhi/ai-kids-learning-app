"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Sparkles,
  Trophy,
  Brain,
  Rocket,
  Star,
  Check,
  X,
} from "lucide-react";

type Question = {
  question: string;
  options: string[];
  answer: string;
};

export default function QuizPage() {
  const router = useRouter();

  const [topic, setTopic] = useState("");
  const [quiz, setQuiz] = useState<Question[]>([]);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<{
    [key: number]: string;
  }>({});

  const [showResult, setShowResult] = useState(false);
  const [score, setScore] = useState(0);
  const [error, setError] = useState("");
  const [loadingText, setLoadingText] = useState("");

  useEffect(() => {
    if (!loading) return;

    const messages = [
      "🧠 Creating smart questions...",
      "✨ Adding fun quiz challenges...",
      "🚀 Preparing your adventure...",
      "🎮 Building a magical quiz...",
    ];

    let index = 0;

    setLoadingText(messages[0]);

    const interval = setInterval(() => {
      index = (index + 1) % messages.length;
      setLoadingText(messages[index]);
    }, 1600);

    return () => clearInterval(interval);
  }, [loading]);

  const generateQuiz = async () => {
    if (!topic) return;

    setLoading(true);
    setQuiz([]);
    setSelected({});
    setShowResult(false);
    setScore(0);
    setError("");

    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topic }),
      });

      const data = await res.json();

      try {
        const parsed = JSON.parse(data.quiz);
        setQuiz(parsed);
      } catch {
        setError(data.quiz || "Failed to generate quiz");
      }
    } catch (err) {
      console.error(err);
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (qIndex: number, option: string) => {
    if (showResult) return;

    setSelected({
      ...selected,
      [qIndex]: option,
    });
  };

  const submitQuiz = () => {
    let correct = 0;

    quiz.forEach((q, i) => {
      if (selected[i] === q.answer) {
        correct++;
      }
    });

    setScore(correct);
    setShowResult(true);
  };

  const progress = useMemo(() => {
    if (quiz.length === 0) return 0;

    return (Object.keys(selected).length / quiz.length) * 100;
  }, [selected, quiz]);

  const suggestedTopics = [
    "🦁 Animals",
    "🌍 Space",
    "🦕 Dinosaurs",
    "🌱 Plants",
    "⚡ Science",
    "🌊 Ocean",
  ];

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-yellow-50 via-white to-orange-100">
      {/* Background Glow */}
      <div className="absolute left-0 top-0 h-72 w-72 rounded-full bg-yellow-200/30 blur-3xl" />
      <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-orange-200/30 blur-3xl" />

      <div className="relative z-10 mx-auto max-w-6xl px-4 py-6 md:px-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <button
            onClick={() => router.back()}
            className="
              flex items-center gap-2
              rounded-full
              bg-white/80
              px-4 py-3
              text-sm font-semibold text-slate-700
              shadow-lg
              backdrop-blur-md
              transition-all
              hover:scale-105
              active:scale-95
            "
          >
            <ArrowLeft size={18} />
            Back
          </button>

          <div
            className="
              hidden md:flex
              items-center gap-2
              rounded-full
              bg-white/70
              px-4 py-2
              text-sm text-slate-600
              shadow-md
              backdrop-blur-md
            "
          >
            <Sparkles size={16} className="text-yellow-500" />
            Fun & Safe Learning
          </div>
        </div>

        {/* Hero Section */}
        <div
          className="
            mb-8
            rounded-[32px]
            border border-white/50
            bg-white/70
            p-6
            shadow-[0_10px_50px_rgba(0,0,0,0.08)]
            backdrop-blur-xl
            md:p-10
          "
        >
          <div className="grid items-center gap-8 md:grid-cols-2">
            {/* Left */}
            <div>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-yellow-100 px-4 py-2 text-sm font-semibold text-yellow-700">
                <Trophy size={16} />
                AI Quiz Challenge
              </div>

              <h1 className="mb-4 text-4xl font-extrabold leading-tight text-slate-800 md:text-5xl">
                Ready to Test
                <span className="block bg-gradient-to-r from-yellow-500 to-orange-500 bg-clip-text text-transparent">
                  Your Knowledge? 🎮
                </span>
              </h1>

              <p className="mb-6 text-lg leading-relaxed text-slate-600">
                Play fun AI-powered quizzes and earn stars, badges, and rewards!
              </p>

              {/* Input Card */}
              <div className="rounded-3xl bg-white p-4 shadow-lg">
                <div className="flex flex-col gap-3 md:flex-row">
                  <input
                    className="
                      flex-1 rounded-2xl border border-slate-200
                      bg-slate-50
                      px-5 py-4
                      text-lg
                      outline-none
                      transition-all
                      focus:border-yellow-400
                      focus:ring-4
                      focus:ring-yellow-100
                    "
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="Choose a quiz topic..."
                  />

                  <button
                    onClick={generateQuiz}
                    disabled={loading}
                    className="
                      rounded-2xl
                      bg-gradient-to-r
                      from-yellow-500
                      to-orange-500
                      px-6 py-4
                      font-bold
                      text-white
                      shadow-lg
                      transition-all
                      hover:scale-105
                      hover:shadow-xl
                      active:scale-95
                      disabled:opacity-70
                    "
                  >
                    {loading ? "Creating..." : "Start Quiz"}
                  </button>
                </div>

                {/* Suggested Topics */}
                <div className="mt-4 flex flex-wrap gap-2">
                  {suggestedTopics.map((item) => (
                    <button
                      key={item}
                      onClick={() =>
                        setTopic(item.replace(/[^\w\s]/gi, "").trim())
                      }
                      className="
                        rounded-full
                        bg-slate-100
                        px-4 py-2
                        text-sm font-medium text-slate-700
                        transition-all
                        hover:scale-105
                        hover:bg-yellow-100
                      "
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Mascot */}
            <div className="relative flex justify-center">
              <div
                className="
                  flex h-80 w-80 items-center justify-center
                  rounded-full
                  bg-gradient-to-br
                  from-yellow-200
                  to-orange-200
                  shadow-2xl
                "
              >
                <div
                  className="
                    flex h-60 w-60 flex-col items-center justify-center
                    rounded-full
                    bg-white/80
                    backdrop-blur-md
                  "
                >
                  <div className="mb-3 text-7xl">🎮</div>

                  <p className="text-center font-bold text-slate-700">
                    Quiz Master Milo
                  </p>

                  <p className="mt-2 px-6 text-center text-sm text-slate-500">
                    “Let’s see what you know!”
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="mx-auto max-w-4xl">
            <div
              className="
                rounded-[32px]
                bg-white/80
                p-8
                shadow-xl
                backdrop-blur-xl
              "
            >
              <div className="mb-6 flex flex-col items-center justify-center">
                <div className="mb-4 animate-bounce text-6xl">🎮</div>

                <h2 className="text-2xl font-bold text-slate-800">
                  Building your quiz...
                </h2>

                <p className="mt-2 text-slate-500">{loadingText}</p>
              </div>

              <div className="space-y-4">
                {[1, 2, 3].map((item) => (
                  <div
                    key={item}
                    className="
                      animate-pulse
                      rounded-3xl
                      bg-slate-100
                      p-6
                    "
                  >
                    <div className="mb-4 h-5 w-40 rounded bg-slate-200" />
                    <div className="grid gap-3">
                      <div className="h-14 rounded-2xl bg-slate-200" />
                      <div className="h-14 rounded-2xl bg-slate-200" />
                      <div className="h-14 rounded-2xl bg-slate-200" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-auto mb-6 max-w-2xl rounded-3xl bg-red-100 p-5 text-center text-red-600 shadow-md">
            {error}
          </div>
        )}

        {/* Quiz */}
        {quiz.length > 0 && !loading && (
          <div className="mx-auto max-w-4xl">
            {/* Progress */}
            <div
              className="
                mb-6
                rounded-3xl
                bg-white/80
                p-5
                shadow-lg
                backdrop-blur-xl
              "
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-bold text-slate-800">
                  Quiz Progress
                </h2>

                <span className="text-sm font-semibold text-slate-500">
                  {Object.keys(selected).length} / {quiz.length} answered
                </span>
              </div>

              <div className="h-4 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="
                    h-full rounded-full
                    bg-gradient-to-r
                    from-yellow-400
                    to-orange-500
                    transition-all duration-500
                  "
                  style={{
                    width: `${progress}%`,
                  }}
                />
              </div>
            </div>

            {/* Questions */}
            <div className="space-y-6">
              {quiz.map((q, i) => (
                <div
                  key={i}
                  className="
                    rounded-[32px]
                    bg-white/80
                    p-6
                    shadow-[0_10px_40px_rgba(0,0,0,0.08)]
                    backdrop-blur-xl
                  "
                >
                  {/* Question Header */}
                  <div className="mb-6 flex items-start gap-4">
                    <div
                      className="
                        flex h-12 w-12 items-center justify-center
                        rounded-2xl
                        bg-yellow-100
                        font-bold text-yellow-700
                      "
                    >
                      {i + 1}
                    </div>

                    <div>
                      <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-yellow-600">
                        Question {i + 1}
                      </p>

                      <h2 className="text-2xl font-bold leading-relaxed text-slate-800">
                        {q.question}
                      </h2>
                    </div>
                  </div>

                  {/* Answers */}
                  <div className="grid gap-4">
                    {q.options.map((opt, idx) => {
                      const isSelected = selected[i] === opt;
                      const isCorrect = opt === q.answer;

                      let styles =
                        "border-slate-200 bg-white hover:border-yellow-300 hover:bg-yellow-50";

                      if (showResult) {
                        if (isCorrect) {
                          styles =
                            "border-green-400 bg-green-100 shadow-green-100";
                        } else if (isSelected) {
                          styles =
                            "border-red-400 bg-red-100 shadow-red-100";
                        }
                      } else if (isSelected) {
                        styles =
                          "border-yellow-400 bg-yellow-100 shadow-yellow-100";
                      }

                      return (
                        <button
                          key={idx}
                          onClick={() => handleSelect(i, opt)}
                          className={`
                            group
                            flex items-center justify-between
                            rounded-3xl
                            border-2
                            p-5
                            text-left
                            shadow-sm
                            transition-all duration-200
                            hover:scale-[1.02]
                            active:scale-[0.98]
                            ${styles}
                          `}
                        >
                          <div className="flex items-center gap-4">
                            <div
                              className="
                                flex h-10 w-10 items-center justify-center
                                rounded-full
                                bg-slate-100
                                font-bold text-slate-600
                              "
                            >
                              {String.fromCharCode(65 + idx)}
                            </div>

                            <span className="text-lg font-semibold text-slate-700">
                              {opt}
                            </span>
                          </div>

                          {showResult && isCorrect && (
                            <Check className="text-green-600" size={24} />
                          )}

                          {showResult &&
                            isSelected &&
                            !isCorrect && (
                              <X className="text-red-600" size={24} />
                            )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Submit */}
            {!showResult && (
              <div className="mt-8 text-center">
                <button
                  onClick={submitQuiz}
                  className="
                    inline-flex items-center gap-3
                    rounded-3xl
                    bg-gradient-to-r
                    from-green-500
                    to-emerald-500
                    px-8 py-5
                    text-lg font-bold
                    text-white
                    shadow-2xl
                    transition-all
                    hover:scale-105
                    active:scale-95
                  "
                >
                  <Rocket size={22} />
                  Submit Answers
                </button>
              </div>
            )}

            {/* Result Screen */}
            {showResult && (
              <div
                className="
                  mt-10
                  rounded-[40px]
                  bg-gradient-to-br
                  from-yellow-400
                  via-orange-400
                  to-pink-400
                  p-10
                  text-center
                  text-white
                  shadow-[0_20px_80px_rgba(0,0,0,0.15)]
                "
              >
                <div className="mb-4 text-7xl">🏆</div>

                <h2 className="mb-3 text-4xl font-extrabold">
                  Amazing Work!
                </h2>

                <p className="mb-6 text-xl text-white/90">
                  You scored {score} out of {quiz.length}
                </p>

                {/* Stars */}
                <div className="mb-6 flex justify-center gap-2">
                  {[1, 2, 3].map((item) => (
                    <Star
                      key={item}
                      className={`${
                        score >= item
                          ? "fill-white text-white"
                          : "text-white/40"
                      }`}
                      size={40}
                    />
                  ))}
                </div>

                <div
                  className="
                    mx-auto mb-8 max-w-xl
                    rounded-3xl
                    bg-white/20
                    p-5
                    backdrop-blur-md
                  "
                >
                  <p className="text-lg font-medium">
                    {score === quiz.length
                      ? "🌟 Perfect score! You're a quiz champion!"
                      : score >= quiz.length / 2
                      ? "🎉 Awesome job! Keep learning and growing!"
                      : "💪 Great effort! Every quiz makes you smarter!"}
                  </p>
                </div>

                {/* Badge */}
                <div
                  className="
                    mx-auto mb-8 inline-flex items-center gap-3
                    rounded-full
                    bg-white
                    px-6 py-4
                    font-bold
                    text-orange-600
                    shadow-xl
                  "
                >
                  <Brain size={22} />
                  Quiz Explorer Badge Earned!
                </div>

                {/* Actions */}
                <div className="flex flex-col justify-center gap-4 md:flex-row">
                  <button
                    onClick={generateQuiz}
                    className="
                      rounded-2xl
                      bg-white
                      px-8 py-4
                      font-bold
                      text-slate-800
                      transition-all
                      hover:scale-105
                    "
                  >
                    🔄 Play Again
                  </button>

                  <Link
                    href="/lesson"
                    className="
                      rounded-2xl
                      bg-black/20
                      px-8 py-4
                      font-bold
                      text-white
                      backdrop-blur-md
                      transition-all
                      hover:scale-105
                      block
                    "
                  >
                    📚 Learn More
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Empty State */}
        {!loading && quiz.length === 0 && !error && (
          <div className="mt-16 flex flex-col items-center justify-center text-center">
            <div className="mb-4 text-7xl">🎮</div>

            <h2 className="mb-2 text-3xl font-bold text-slate-800">
              Start Your Quiz Adventure
            </h2>

            <p className="max-w-md text-lg text-slate-500">
              Pick a topic and test your knowledge with fun AI-powered quizzes!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}