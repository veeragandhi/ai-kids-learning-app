"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Sparkles,
  Volume2,
  BookOpen,
  Stars,
  Brain,
  Rocket,
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  X,
  Video,
} from "lucide-react";

interface VideoSlide {
  id: number;
  type: "title" | "fact" | "example" | "outro";
  heading: string;
  body: string;
  emoji: string;
  gradient: string;
  durationSeconds: number;
}

interface VideoScript {
  topic: string;
  age: number;
  totalDuration: number;
  slides: VideoSlide[];
}

export default function LessonPage() {
  const [topic, setTopic] = useState("");
  const [lesson, setLesson] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [error, setError] = useState("");

  // Video state
  const [videoScript, setVideoScript] = useState<VideoScript | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

  const router = useRouter();
  const searchParams = useSearchParams();
  const [isSpeaking, setIsSpeaking] = useState(false);

  useEffect(() => {
    const topicFromUrl = searchParams.get("topic");

    if (topicFromUrl) {
      setTopic(topicFromUrl);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!loading) return;

    const messages = [
      "🌟 Preparing your magical lesson...",
      "📚 Finding fun facts...",
      "🧠 Creating examples for kids...",
      "✨ Making learning exciting...",
      "🚀 Almost ready...",
    ];

    let index = 0;

    setLoadingText(messages[0]);

    const interval = setInterval(() => {
      index = (index + 1) % messages.length;
      setLoadingText(messages[index]);
    }, 1800);

    return () => clearInterval(interval);
  }, [loading]);

  const handleReadAloud = () => {
  if (!lesson) return;

  // Stop current speech if already speaking
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    setIsSpeaking(false);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(lesson);

  utterance.rate = 0.9;
  utterance.pitch = 1.1;
  utterance.volume = 1;

  // Optional: choose kid-friendly voice
  const voices = speechSynthesis.getVoices();

  const preferredVoice =
    voices.find((voice) =>
      voice.name.toLowerCase().includes("female")
    ) || voices[0];

  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }

  utterance.onstart = () => {
    setIsSpeaking(true);
  };

  utterance.onend = () => {
    setIsSpeaking(false);
  };

  utterance.onerror = () => {
    setIsSpeaking(false);
  };

  speechSynthesis.speak(utterance);
};


  // ── Video generation ──────────────────────────────────────────────────────

  const generateVideo = async () => {
    if (!lesson || !topic) return;
    setVideoLoading(true);
    try {
      const res = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, age: 6 }),
      });
      const data = await res.json();
      if (data.script) {
        setVideoScript(data.script);
        setCurrentSlide(0);
        setVideoOpen(true);
        startVideoPlayFn(data.script, 0);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setVideoLoading(false);
    }
  };

  const startVideoPlayFn = (script: VideoScript, startIndex: number) => {
    setIsPlaying(true);
    elapsedRef.current = 0;
    setProgress(0);
    if (progressRef.current) clearInterval(progressRef.current);
    let idx = startIndex;
    progressRef.current = setInterval(() => {
      elapsedRef.current += 0.1;
      const slide = script.slides[idx];
      if (!slide) return;
      const pct = Math.min(100, (elapsedRef.current / slide.durationSeconds) * 100);
      setProgress(pct);
      if (elapsedRef.current >= slide.durationSeconds) {
        elapsedRef.current = 0;
        if (idx < script.slides.length - 1) {
          idx += 1;
          setCurrentSlide(idx);
        } else {
          clearInterval(progressRef.current!);
          setIsPlaying(false);
        }
      }
    }, 100);
  };

  const toggleVideoPlay = () => {
    if (!videoScript) return;
    if (isPlaying) {
      clearInterval(progressRef.current!);
      setIsPlaying(false);
    } else {
      startVideoPlayFn(videoScript, currentSlide);
    }
  };

  const goToSlide = (i: number) => {
    if (!videoScript) return;
    clearInterval(progressRef.current!);
    elapsedRef.current = 0;
    setProgress(0);
    setCurrentSlide(i);
    if (isPlaying) startVideoPlayFn(videoScript, i);
    const slide = videoScript.slides[i];
    if (slide && speechSynthesis) {
      speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(`${slide.heading}. ${slide.body}`);
      utt.rate = 0.85; utt.pitch = 1.1;
      const voices = speechSynthesis.getVoices();
      const voice = voices.find((v) => v.name.toLowerCase().includes("female")) || voices[0];
      if (voice) utt.voice = voice;
      speechSynthesis.speak(utt);
    }
  };

  const generateLesson = async () => {
    if (!topic) return;

    setLoading(true);
    setLesson("");
    setError("");

    try {
      console.log("[lesson page] Generating lesson for topic:", topic);
      const res = await fetch("/api/lesson", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topic }),
      });

      console.log("[lesson page] Response status:", res.status);
      const data = await res.json();
      console.log("[lesson page] Response data:", data);

      if (!data.lesson) {
        console.error("[lesson page] No lesson in response:", data);
        setError("Failed to generate lesson. Please try again.");
        return;
      }

      setLesson(data.lesson);
    } catch (err) {
      console.error("[lesson page] Error:", err);
      setError(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  const suggestedTopics = [
    "🌱 Plants",
    "🦁 Animals",
    "🌍 Space",
    "🦕 Dinosaurs",
    "🌊 Ocean",
    "☀️ Solar System",
  ];

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-sky-50 via-white to-violet-100">
      {/* Background Glow Effects */}
      <div className="absolute top-0 left-0 h-72 w-72 rounded-full bg-sky-200/30 blur-3xl" />
      <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-purple-200/30 blur-3xl" />

      <div className="relative z-10 mx-auto max-w-6xl px-4 py-6 md:px-8">
        {/* Top Header */}
        <div className="mb-8 flex items-center justify-between">
          {/* Back Button */}
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
              hover:bg-white
              active:scale-95
            "
          >
            <ArrowLeft size={18} />
            Back
          </button>

          {/* Trust Badge */}
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
            Safe AI Learning for Kids
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
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-violet-100 px-4 py-2 text-sm font-semibold text-violet-700">
                <Stars size={16} />
                AI Learning Adventure
              </div>

              <h1 className="mb-4 text-4xl font-extrabold leading-tight text-slate-800 md:text-5xl">
                Learn Something
                <span className="block bg-gradient-to-r from-sky-500 to-violet-500 bg-clip-text text-transparent">
                  Amazing Today ✨
                </span>
              </h1>

              <p className="mb-6 text-lg leading-relaxed text-slate-600">
                Explore fun AI-generated lessons made from your child’s learning
                materials.
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
                      focus:border-sky-400
                      focus:ring-4
                      focus:ring-sky-100
                    "
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="What do you want to learn?"
                  />

                  <button
                    onClick={generateLesson}
                    disabled={loading}
                    className="
                      rounded-2xl
                      bg-gradient-to-r
                      from-sky-500
                      to-violet-500
                      px-6 py-4
                      font-bold
                      text-white
                      shadow-lg
                      transition-all
                      hover:scale-105
                      hover:shadow-xl
                      active:scale-95
                      disabled:cursor-not-allowed
                      disabled:opacity-70
                    "
                  >
                    {loading ? "Creating..." : "Start Adventure"}
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
                        hover:bg-sky-100
                      "
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Illustration Area */}
            <div className="relative flex justify-center">
              <div
                className="
                  flex h-80 w-80 items-center justify-center
                  rounded-full
                  bg-gradient-to-br
                  from-sky-200
                  to-violet-200
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
                  <div className="mb-3 text-7xl">🦉</div>

                  <p className="text-center font-bold text-slate-700">
                    AmigosNest the AI Teacher
                  </p>

                  <p className="mt-2 px-6 text-center text-sm text-slate-500">
                    “Learning is an adventure!”
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
                <div className="mb-4 animate-bounce text-6xl">🦉</div>

                <h2 className="text-2xl font-bold text-slate-800">
                  AmigosNest is preparing your lesson...
                </h2>

                <p className="mt-2 text-slate-500">{loadingText}</p>
              </div>

              {/* Skeleton Cards */}
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
                    <div className="mb-2 h-4 w-full rounded bg-slate-200" />
                    <div className="mb-2 h-4 w-5/6 rounded bg-slate-200" />
                    <div className="h-4 w-3/4 rounded bg-slate-200" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !loading && (
          <div className="mx-auto max-w-4xl">
            <div
              className="
                rounded-[32px]
                bg-red-50/80
                border-2
                border-red-200
                p-8
                shadow-xl
                backdrop-blur-xl
              "
            >
              <div className="mb-4 flex items-start gap-4">
                <div className="text-3xl">⚠️</div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold text-red-800">
                    Oops! Something went wrong
                  </h2>
                  <p className="mt-2 text-red-700">{error}</p>
                  <p className="mt-4 text-sm text-red-600">
                    Make sure Ollama is running with the mistral:latest model.
                  </p>
                  <button
                    onClick={generateLesson}
                    className="mt-4 rounded-full bg-red-500 px-6 py-2 text-white font-semibold hover:bg-red-600 transition"
                  >
                    Try Again
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Lesson Content */}
        {lesson && !loading && (
          <div className="mx-auto max-w-4xl space-y-6">
            {/* Lesson Hero */}
            <div
              className="
                rounded-[32px]
                bg-white/80
                p-8
                shadow-[0_10px_40px_rgba(0,0,0,0.08)]
                backdrop-blur-xl
              "
            >
              <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-sky-100 px-4 py-2 text-sm font-semibold text-sky-700">
                    <BookOpen size={16} />
                    Your AI Lesson
                  </div>

                  <h2 className="text-3xl font-extrabold text-slate-800">
                    {topic}
                  </h2>
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-3">
                  <button onClick={handleReadAloud}
                    className="
                      flex items-center gap-2
                      rounded-2xl
                      bg-violet-100
                      px-5 py-3
                      font-semibold text-violet-700
                      transition-all
                      hover:scale-105
                    "
                  >
                    <Volume2 size={18} />
                    {isSpeaking ? "Stop Reading" : "Read Aloud"}
                  </button>

                  <button
                    onClick={generateVideo}
                    disabled={videoLoading}
                    className="
                      flex items-center gap-2
                      rounded-2xl
                      bg-gradient-to-r from-pink-500 to-orange-400
                      px-5 py-3
                      font-semibold text-white
                      shadow-md
                      transition-all
                      hover:scale-105
                      active:scale-95
                      disabled:opacity-60
                      disabled:cursor-not-allowed
                    "
                  >
                    <Video size={18} />
                    {videoLoading ? "Generating..." : videoScript ? "Watch Again 🎬" : "Watch as Video 🎬"}
                  </button>
                </div>
              </div>

              {/* AI Teacher Bubble */}
              <div
                className="
                  mb-6
                  flex gap-4
                  rounded-3xl
                  bg-gradient-to-r
                  from-sky-50
                  to-violet-50
                  p-5
                "
              >
                <div className="text-4xl">🦉</div>

                <div>
                  <p className="font-bold text-slate-800">
                    AmigosNest says:
                  </p>

                  <p className="mt-1 text-slate-600">
                    “Awesome choice! Let’s explore and learn together.”
                  </p>
                </div>
              </div>

              {/* Lesson Body */}
              <div className="space-y-5">
                <div
                  className="
                    rounded-3xl
                    border border-slate-100
                    bg-white
                    p-6
                    shadow-sm
                  "
                >
                  <div className="mb-4 flex items-center gap-3">
                    <div className="rounded-2xl bg-sky-100 p-3">
                      <Brain className="text-sky-600" size={22} />
                    </div>

                    <h3 className="text-xl font-bold text-slate-800">
                      Let’s Learn
                    </h3>
                  </div>

                  <div className="whitespace-pre-wrap text-lg leading-relaxed text-slate-600">
                    {lesson}
                  </div>
                </div>

                {/* Fun Fact Card */}
                <div
                  className="
                    rounded-3xl
                    bg-gradient-to-r
                    from-yellow-100
                    to-orange-100
                    p-6
                    shadow-md
                  "
                >
                  <div className="mb-3 flex items-center gap-3">
                    <div className="text-3xl">💡</div>

                    <h3 className="text-xl font-bold text-slate-800">
                      Fun Fact
                    </h3>
                  </div>

                  <p className="text-slate-700">
                    Learning becomes easier when we explore with curiosity and
                    imagination!
                  </p>
                </div>

                {/* Continue CTA */}
                <div
                  className="
                    rounded-[32px]
                    bg-gradient-to-r
                    from-sky-500
                    to-violet-500
                    p-8
                    text-white
                    shadow-2xl
                  "
                >
                  <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="mb-2 text-2xl font-bold">
                        Ready for a Quiz?
                      </h3>

                      <p className="text-white/90">
                        Test your knowledge with a fun interactive challenge!
                      </p>
                    </div>

                    <button
                      className="
                        flex items-center justify-center gap-2
                        rounded-2xl
                        bg-white
                        px-6 py-4
                        font-bold
                        text-slate-800
                        transition-all
                        hover:scale-105
                        active:scale-95
                      "
                    >
                      <Rocket size={20} />
                      Start Quiz
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!lesson && !loading && (
          <div className="mt-12 flex flex-col items-center justify-center text-center">
            <div className="mb-4 text-7xl">✨</div>

            <h2 className="mb-2 text-2xl font-bold text-slate-800">
              Choose a Topic to Begin
            </h2>

            <p className="max-w-md text-slate-500">
              Start a magical AI learning adventure designed for curious young
              minds.
            </p>
          </div>
        )}
      </div>

      {/* ── Fullscreen Video Player Modal ── */}
      {videoOpen && videoScript && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90">
          <div className="relative w-full max-w-4xl px-4">

            {/* Close */}
            <button
              onClick={() => {
                setVideoOpen(false);
                clearInterval(progressRef.current!);
                speechSynthesis.cancel();
                setIsPlaying(false);
              }}
              className="absolute -top-12 right-4 flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/20"
            >
              <X size={16} /> Close
            </button>

            {/* Slide stage */}
            <div className="relative overflow-hidden rounded-3xl bg-black" style={{ aspectRatio: "16/9" }}>
              {videoScript.slides.map((slide, i) => (
                <div
                  key={slide.id}
                  className={`absolute inset-0 flex flex-col items-center justify-center p-8 bg-gradient-to-br ${slide.gradient} transition-opacity duration-500 ${i === currentSlide ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                >
                  {/* Decorative background emojis */}
                  <div className="absolute top-6 left-6 text-6xl opacity-20 select-none pointer-events-none">{slide.emoji}</div>
                  <div className="absolute bottom-10 right-24 text-9xl opacity-10 select-none pointer-events-none">{slide.emoji}</div>

                  {/* Content */}
                  <div className="relative z-10 max-w-2xl text-center">
                    {/* Big emoji */}
                    <div className="mb-4 text-7xl drop-shadow-lg">{slide.emoji}</div>

                    {/* Badge */}
                    <div className="mb-3 inline-block rounded-full bg-white/25 px-4 py-1 text-xs font-bold uppercase tracking-widest text-white backdrop-blur-sm">
                      {slide.type === "title" ? "Let's learn" : slide.type === "fact" ? "Fun fact" : slide.type === "example" ? "Example" : "Well done!"}
                    </div>

                    <h2 className="mb-4 text-3xl font-extrabold leading-tight text-white drop-shadow-md md:text-4xl">
                      {slide.heading}
                    </h2>
                    <p className="text-lg leading-relaxed text-white/95 drop-shadow-sm md:text-xl">
                      {slide.body}
                    </p>
                  </div>

                  {/* AmigosNest owl mascot */}
                  <div className="absolute bottom-5 right-5 text-4xl drop-shadow">🦉</div>
                </div>
              ))}
            </div>

            {/* Progress bar */}
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-violet-400 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>

            {/* Controls */}
            <div className="mt-4 flex items-center justify-between">
              {/* Prev */}
              <button
                onClick={() => currentSlide > 0 && goToSlide(currentSlide - 1)}
                disabled={currentSlide === 0}
                className="rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 disabled:opacity-30"
              >
                <ChevronLeft size={22} />
              </button>

              {/* Dots */}
              <div className="flex gap-2">
                {videoScript.slides.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => goToSlide(i)}
                    className={`h-2 rounded-full transition-all ${i === currentSlide ? "w-6 bg-white" : "w-2 bg-white/40"}`}
                  />
                ))}
              </div>

              {/* Play/Pause */}
              <button
                onClick={toggleVideoPlay}
                className="rounded-full bg-gradient-to-r from-sky-500 to-violet-500 p-3 text-white shadow-lg transition hover:scale-105"
              >
                {isPlaying ? <Pause size={22} /> : <Play size={22} />}
              </button>

              {/* Next */}
              <button
                onClick={() => currentSlide < videoScript.slides.length - 1 && goToSlide(currentSlide + 1)}
                disabled={currentSlide === videoScript.slides.length - 1}
                className="rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 disabled:opacity-30"
              >
                <ChevronRight size={22} />
              </button>
            </div>

            {/* Slide counter */}
            <p className="mt-2 text-center text-sm text-white/50">
              Slide {currentSlide + 1} of {videoScript.slides.length} · {videoScript.totalDuration}s lesson
            </p>
          </div>
        </div>
      )}
    </div>
  );
}