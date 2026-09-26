#!/usr/bin/env node
// AmigosNest quiz evaluation — catches the "no valid answer among the
// choices" failure class, not just whether the model returned JSON.
//
// Offline fixtures (always run, no server/Ollama needed) mirror the
// answerability gate in app/api/quiz/route.ts:
//   Q1-type: stem asks X, no option answers it (correct fact missing).
//   Q5-type: options belong to a different question than the stem.
//   wrong-mark: correct option present but a distractor is marked answer.
//   fixed: corrected question passes.
//   swapped-pair: swapping mismatched option sets improves support.
//
// Optional live check (`--live`, needs dev server + Ollama + sample docs):
// posts to /api/quiz and asserts shape (3 options, answer in options,
// unique options, proper question) for every returned question.
//
// Usage:
//   node scripts/evaluate-quiz.mjs
//   node scripts/evaluate-quiz.mjs --live [--base-url http://localhost:3000]
//   node scripts/evaluate-quiz.mjs --json

import process from "node:process";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const live = args.includes("--live");
const baseUrl =
  valueAfter("--base-url") || process.env.ASK_BASE_URL || "http://localhost:3000";

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ── Answerability logic (mirrors app/api/quiz/route.ts) ────────────────────
// Keep in sync with the route: QUIZ_STOPWORDS, synonym groups, 0.3 support
// threshold, top-1 answer sentence, 0.05 answer tolerance.

const QUIZ_STOPWORDS = new Set([
  "what", "which", "how", "who", "why", "when", "where",
  "can", "do", "does", "is", "are", "was", "were",
  "a", "an", "the", "has", "have", "had", "with", "like",
  "many", "much", "more", "most", "of", "in", "on", "for",
  "to", "and", "or", "s", "t", "it", "its",
]);

function quizContentWords(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (w) => w.length > 1 && !QUIZ_STOPWORDS.has(w),
  );
}

function expandQuizSynonyms(words) {
  const out = new Set(words);
  const groups = [
    ["big", "large"],
    ["small", "little"],
    ["mom", "mother", "parents", "parent"],
    ["dad", "father", "parents", "parent"],
    ["kid", "kids", "child", "children"],
    ["grandma", "grandmother", "grandparents"],
    ["grandpa", "grandfather", "grandparents"],
  ];
  for (const g of groups) {
    if (words.some((w) => g.includes(w))) {
      for (const w of g) out.add(w);
    }
  }
  return [...out];
}

function quizContextSentences(context) {
  return String(context || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function topSentencesForQuestion(question, context, k = 2) {
  const sentences = quizContextSentences(context);
  if (sentences.length === 0) return [];
  const qSet = new Set(expandQuizSynonyms(quizContentWords(question)));
  const scored = sentences.map((s) => {
    const sSet = new Set(expandQuizSynonyms(quizContentWords(s)));
    const hits = [...qSet].filter((w) => sSet.has(w)).length;
    return { s, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, Math.max(1, k)).map((e) => e.s);
}

function optionSupport(option, sentences) {
  const oWords = expandQuizSynonyms(quizContentWords(option));
  if (oWords.length === 0) return 0;
  const oSet = new Set(oWords);
  let best = 0;
  for (const s of sentences) {
    const sSet = new Set(expandQuizSynonyms(quizContentWords(s)));
    const hits = [...oSet].filter((w) => sSet.has(w)).length;
    best = Math.max(best, hits / oWords.length);
  }
  return best;
}

function questionBestSupport(question, options, context) {
  if (!context || options.length === 0) return 0;
  const top = topSentencesForQuestion(question, context, 2);
  if (top.length === 0) return 0;
  return Math.max(...options.map((opt) => optionSupport(opt, top)));
}

function isAnswerableQuizQuestion(question, options, answer, context) {
  if (!context || options.length !== 3) return false;
  const top = topSentencesForQuestion(String(question || ""), context, 1);
  if (top.length === 0) return false;
  const supports = options.map((opt) => optionSupport(opt, top));
  const maxSupport = Math.max(...supports);
  if (maxSupport < 0.3) return false;
  const answerSupport = optionSupport(String(answer || ""), top);
  if (answerSupport + 0.05 < maxSupport) return false;
  const minSupport = Math.min(...supports);
  if (maxSupport > 0.5 && maxSupport - minSupport < 0.1) return false;
  return true;
}

// ── Fixtures: the reported atmosphere quiz ──────────────────────────────────

const ATMOSPHERE_CONTEXT = [
  "Humans live and breathe in the troposphere.",
  "Almost all weather happens in the troposphere.",
  "The troposphere extends 6 to 18 kilometers from the Earth's surface.",
  "The Earth's atmosphere is like a cake with several layers.",
  "Weather words tell us about the different ways we experience the weather, such as sunny, cloudy, rainy, and windy days.",
  "The stratosphere sits above the troposphere.",
  "The mesosphere sits above the stratosphere.",
].join(" ");

const BROKEN_Q1 = {
  question: "What layer of the atmosphere do humans live and breathe in?",
  options: [
    "The distance to the sun",
    "The colors of clouds",
    "The different ways we experience the weather",
  ],
  answer: "The different ways we experience the weather",
};

const BROKEN_Q5 = {
  question: "What do weather words tell us about the weather?",
  options: ["The mesosphere", "The stratosphere", "The troposphere"],
  answer: "The mesosphere",
};

const FIXED_Q1 = {
  question: "What layer of the atmosphere do humans live and breathe in?",
  options: ["The troposphere", "The mesosphere", "The stratosphere"],
  answer: "The troposphere",
};

const FIXED_Q5 = {
  question: "What do weather words tell us about the weather?",
  options: [
    "The different ways we experience the weather",
    "The distance to the sun",
    "The colors of clouds",
  ],
  answer: "The different ways we experience the weather",
};

const WRONG_MARK = {
  ...FIXED_Q1,
  answer: "The mesosphere", // correct option present, distractor marked
};

const results = [];

function check(id, passed, failures) {
  results.push({ id, passed, failures });
}

// F1 — broken Q1 must FAIL answerability (no option is the layer).
{
  const ok = isAnswerableQuizQuestion(
    BROKEN_Q1.question, BROKEN_Q1.options, BROKEN_Q1.answer, ATMOSPHERE_CONTEXT,
  );
  check("broken-q1-rejected", ok === false,
    ok ? ["broken Q1 passed answerability but none of its options is the layer"] : []);
}

// F2 — broken Q5 must FAIL answerability (layer names can't answer it;
// the marked answer is not the supported option either).
{
  const ok = isAnswerableQuizQuestion(
    BROKEN_Q5.question, BROKEN_Q5.options, BROKEN_Q5.answer, ATMOSPHERE_CONTEXT,
  );
  check("broken-q5-rejected", ok === false,
    ok ? ["broken Q5 passed answerability but its options belong to another question"] : []);
}

// F3 — corrected Q1 must PASS.
{
  const ok = isAnswerableQuizQuestion(
    FIXED_Q1.question, FIXED_Q1.options, FIXED_Q1.answer, ATMOSPHERE_CONTEXT,
  );
  check("fixed-q1-accepted", ok === true,
    ok ? [] : ["corrected Q1 (troposphere among layers) failed answerability"]);
}

// F4 — corrected Q5 must PASS.
{
  const ok = isAnswerableQuizQuestion(
    FIXED_Q5.question, FIXED_Q5.options, FIXED_Q5.answer, ATMOSPHERE_CONTEXT,
  );
  check("fixed-q5-accepted", ok === true,
    ok ? [] : ["corrected Q5 (weather descriptions) failed answerability"]);
}

// F5 — right options, wrong answer marked → must FAIL.
{
  const ok = isAnswerableQuizQuestion(
    WRONG_MARK.question, WRONG_MARK.options, WRONG_MARK.answer, ATMOSPHERE_CONTEXT,
  );
  check("wrong-answer-rejected", ok === false,
    ok ? ["quiz with a distractor marked as answer passed answerability"] : []);
}

// F6 — swapped-pair repair signal: the mismatched pairing scores worse than
// the corrected pairing, so the route's swap-fixer can see the improvement.
{
  const current =
    questionBestSupport(BROKEN_Q1.question, BROKEN_Q1.options, ATMOSPHERE_CONTEXT) +
    questionBestSupport(BROKEN_Q5.question, BROKEN_Q5.options, ATMOSPHERE_CONTEXT);
  const swapped =
    questionBestSupport(BROKEN_Q1.question, FIXED_Q1.options, ATMOSPHERE_CONTEXT) +
    questionBestSupport(BROKEN_Q5.question, FIXED_Q5.options, ATMOSPHERE_CONTEXT);
  check("swapped-pair-detectable", swapped > current + 0.3,
    swapped > current + 0.3
      ? []
      : [`swap signal too weak (current ${current.toFixed(2)} -> swapped ${swapped.toFixed(2)})`]);
}

// F7 — generic shape gate every quiz must clear: exactly 3 unique options
// and the answer word-for-word among them.
function shapeOk(q) {
  if (!Array.isArray(q.options) || q.options.length !== 3) return false;
  if (new Set(q.options.map((o) => String(o).trim().toLowerCase())).size !== 3) return false;
  return q.options.includes(q.answer);
}
{
  const broken = [BROKEN_Q1, BROKEN_Q5].every(shapeOk);
  const fixed = [FIXED_Q1, FIXED_Q5].every(shapeOk);
  check("answer-among-choices", broken && fixed,
    broken && fixed ? [] : ["shape gate misbehaves on fixtures"]);
}

// ── Optional live check ─────────────────────────────────────────────────────

async function liveCheck() {
  const started = Date.now();
  const failures = [];
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/quiz`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Elephant Trunk", age: 8, numQuestions: 3 }),
    });
    if (res.status !== 200) {
      failures.push(`expected HTTP 200, received ${res.status}`);
    } else {
      const data = await res.json();
      let quiz;
      try {
        quiz = JSON.parse(data.quiz);
      } catch {
        failures.push("live quiz is not parseable JSON");
      }
      if (quiz) {
        if (!Array.isArray(quiz) || quiz.length !== 3) {
          failures.push(`expected 3 live questions, got ${Array.isArray(quiz) ? quiz.length : "non-array"}`);
        } else {
          quiz.forEach((q, i) => {
            if (typeof q.question !== "string" || !q.question.includes("?")) {
              failures.push(`live Q${i + 1} is not a question`);
            }
            if (!Array.isArray(q.options) || q.options.length !== 3) {
              failures.push(`live Q${i + 1} does not have exactly 3 options`);
            } else {
              if (new Set(q.options.map((o) => String(o).trim().toLowerCase())).size !== 3) {
                failures.push(`live Q${i + 1} has duplicate options`);
              }
              if (!q.options.includes(q.answer)) {
                failures.push(`live Q${i + 1} answer is not among its options`);
              }
            }
          });
        }
      }
    }
  } catch (e) {
    failures.push(`live request failed: ${e.message} (is the dev server running?)`);
  }
  check("live-quiz-shape", failures.length === 0, failures);
  results[results.length - 1].elapsedMs = Date.now() - started;
}

if (live) await liveCheck();

const passed = results.filter((r) => r.passed).length;
if (jsonOutput) {
  console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"} ${r.id}`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
  console.log(`\nQuiz evaluation: ${passed}/${results.length} passed`);
}
process.exitCode = passed === results.length ? 0 : 1;
