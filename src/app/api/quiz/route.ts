import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";
import { verifyChildOwnership } from "@/lib/supabase/requireChild";
import { toTeachingText } from "@/lib/ocr";
import { defaultQuizForTopic, type FallbackQuizQuestion } from "@/lib/quiz-fallback";

const QUIZ_STOPWORDS = new Set([
  "what", "which", "how", "who", "why", "when", "where",
  "can", "do", "does", "is", "are", "was", "were",
  "a", "an", "the", "has", "have", "had", "with", "like",
  "many", "much", "more", "most", "of", "in", "on", "for",
  "to", "and", "or", "s", "t", "it", "its",
]);

function quizContentWords(text: string): string[] {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !QUIZ_STOPWORDS.has(w));
}

// How much do the options just echo the question stem?
// 1.0 = an option repeats the question wording (e.g. Q asks about
// "one or two children" and an option IS "One or two children").
function echoScore(question: string, options: string[]): number {
  const qWords = new Set(quizContentWords(question));
  const qLower = String(question).toLowerCase();
  let max = 0;
  for (const opt of options) {
    const oWords = quizContentWords(opt);
    if (oWords.length === 0) continue;
    const oLower = String(opt).toLowerCase().trim();
    // Full-phrase echo: option text appears inside the question.
    if (oLower.length > 4 && qLower.includes(oLower)) {
      max = Math.max(max, 1);
      continue;
    }
    const common = oWords.filter((w) => qWords.has(w)).length;
    max = Math.max(max, common / oWords.length);
  }
  return max;
}

// Score how well a question+answer pair is grounded in the retrieved context.
// Returns 0..1; low means the question is likely hallucinated.
function quizGroundingScore(question: string, options: string[], answer: string, context: string): number {
  if (!context) return 0;
  const qTokens = new Set(quizContentWords(question));
  const aTokens = new Set(quizContentWords(answer));
  const qaTokens = new Set<string>([...qTokens, ...aTokens]);
  const oTokens = new Set(
    options.flatMap((option) => quizContentWords(option))
  );
  const contextTokens = new Set(quizContentWords(context));
  if (contextTokens.size === 0) return 0;

  const qaHits = [...qaTokens].filter((token) => contextTokens.has(token)).length;
  const oHits = [...oTokens].filter((token) => contextTokens.has(token)).length;
  // Question + answer must come from the context (the "asked about African
  // elephants when the lesson only mentions elephants" detector). Option
  // tokens count half: plausible distractors are EXPECTED to be absent from
  // the lesson — "clearly FALSE" often means not-in-context — and counting
  // them full weight rejected correct quizzes at 0.33 vs the 0.35 bar.
  return (2 * qaHits + oHits) / Math.max(1, 2 * qaTokens.size + oTokens.size);
}

// Reject a quiz where the question/answer pair does not look grounded in the
// retrieved context (catches the "ask about African elephant when lesson does
// not mention elephants" failure mode).
function quizGroundedInContext(quiz: unknown, context: string): boolean {
  if (!Array.isArray(quiz) || quiz.length === 0) return false;
  return quiz.every((entry) => {
    const q = entry as { options?: unknown; answer?: unknown; question?: unknown };
    const options = Array.isArray(q?.options)
      ? q.options.filter((opt): opt is string => typeof opt === "string")
      : [];
    const answer = typeof q?.answer === "string" ? q.answer : String(q?.answer ?? "");
    const question = typeof q?.question === "string" ? q.question : String(q?.question ?? "");
    const score = quizGroundingScore(question, options, answer, context);
    if (score < 0.35) {
      console.error(
        `[quiz] Not grounded (score ${score.toFixed(2)}): ${question.slice(0, 80)}`
      );
      return false;
    }
    return true;
  });
}

// Pick the option best supported by the retrieved context: find the
// context sentence closest to the question, then the option closest to
// that sentence. Synonym-aware so "big" matches "large", etc.
function expandQuizSynonyms(words: string[]): Set<string> {
  const out = new Set(words);
  const groups: string[][] = [
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
  return out;
}

// ── Answerability: every question must have a valid answer AMONG its
// choices (the reported atmosphere-quiz bug). Two failure modes:
//   Q1-type: no option answers the stem ("What layer do humans live in?"
//     + options about sun distance / cloud colors). The correct fact
//     (troposphere) is missing from the options.
//   Q5-type: options belong to a different question ("What do weather
//     words tell us?" + layer names as options).
// Check: find the context sentence(s) closest to the question stem, then
// require (a) at least one option to match that sentence, and (b) the
// marked answer to BE that best-matching option. Synonym-aware so
// "kid/kids/child/children" still match.
function quizContextSentences(context: string): string[] {
  return String(context || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function topSentencesForQuestion(
  question: string,
  context: string,
  k = 2
): string[] {
  const sentences = quizContextSentences(context);
  if (sentences.length === 0) return [];
  const qWords = expandQuizSynonyms(quizContentWords(question));
  const qSet = new Set(qWords);
  const scored = sentences.map((s) => {
    const sSet = new Set(expandQuizSynonyms(quizContentWords(s)));
    const hits = [...qSet].filter((w) => sSet.has(w)).length;
    return { s, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, Math.max(1, k)).map((e) => e.s);
}

// Fraction of the option's content words found in the candidate answer
// sentence(s). 1.0 = the option is fully stated by the sentence.
function optionSupport(option: string, sentences: string[]): number {
  const oWords = [...expandQuizSynonyms(quizContentWords(option))];
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

// Best option support for one question: how well does the single most
// supported option match the question's answer sentence?
function questionBestSupport(
  question: string,
  options: string[],
  context: string
): number {
  if (!context || options.length === 0) return 0;
  const top = topSentencesForQuestion(question, context, 2);
  if (top.length === 0) return 0;
  return Math.max(...options.map((opt) => optionSupport(opt, top)));
}

// Sentences that can legitimately support an answer to the stem: every
// sentence tied for best match with the stem's words, their immediate
// neighbors, and — while one of those leans on a pronoun/demonstrative
// ("This layer…", "It's…") — the referring chain behind it, so the
// antecedent ("…the troposphere") counts as support. Strictly local:
// options belonging to a different question (Q5-type) are almost never in
// this window, so that guard keeps its teeth. The window's first entry is
// the single best-matching sentence — the stem's answer sentence.
function answerCandidateSentences(question: string, context: string): string[] {
  const sentences = quizContextSentences(context);
  if (sentences.length === 0) return [];
  const qSet = new Set(expandQuizSynonyms(quizContentWords(question)));
  const hits = sentences.map((s) => {
    const sSet = new Set(expandQuizSynonyms(quizContentWords(s)));
    return [...qSet].filter((w) => sSet.has(w)).length;
  });
  const maxHits = Math.max(...hits);
  const seeds: number[] = [];
  if (maxHits > 0) {
    hits.forEach((h, i) => {
      if (h === maxHits) seeds.push(i);
    });
  } else {
    seeds.push(0);
  }
  const DEMONSTRATIVE = /^(this|that|these|those|it|its|it's|they|them|their)\b/i;
  const seen = new Set<number>();
  const picked: number[] = [];
  const push = (i: number): void => {
    if (i >= 0 && i < sentences.length && !seen.has(i)) {
      seen.add(i);
      picked.push(i);
    }
  };
  // Every tied-best sentence pulls its neighbors…
  seeds.forEach((i) => {
    push(i);
    push(i - 1);
    push(i + 1);
  });
  // …and referents extend the walk ("It's where we live and breathe!" →
  // "…called the troposphere").
  for (let qi = 0; qi < picked.length && picked.length < 10; qi++) {
    const i = picked[qi];
    if (!DEMONSTRATIVE.test(sentences[i])) continue;
    push(i - 1);
    push(i + 1);
  }
  return picked.map((i) => sentences[i]);
}

// Paraphrase rescue: the marked answer can be correct while its sentence
// shares no words with the stem — "What does the text compare the Earth's
// atmosphere to?" → "…is like a cake with different layers" ("several" vs
// "different"). Pull such a sentence into the window ONLY when it strongly
// supports the answer AND is linked to the stem: a shared content word, or
// a comparison stem ("compare…", "…like?") matched by a comparison sentence
// ("is like…"). Unlinked answer sentences stay out, so a fact belonging to
// a different question (F1/F2-type) still fails gate (a)/(b).
function linkAnswerSentences(
  question: string,
  answer: string,
  context: string,
  window: string[]
): string[] {
  if (!answer || !question) return window;
  const sentences = quizContextSentences(context);
  if (sentences.length === 0) return window;
  const qWords = new Set(expandQuizSynonyms(quizContentWords(question)));
  const qRaw = String(question).toLowerCase();
  const stemCompares = /\b(compare|compared|comparison|resemble|resembles|similar|describe|describes|depict|depicts|like)\b/.test(qRaw);
  const inWindow = new Set(window);
  const linked: string[] = [];
  for (const s of sentences) {
    if (inWindow.has(s)) continue;
    if (optionSupport(answer, [s]) < 0.5) continue;
    const sSet = new Set(expandQuizSynonyms(quizContentWords(s)));
    const shared = [...qWords].filter((w) => sSet.has(w)).length;
    const compareLink = stemCompares && /\b(like|resembles|similar to|compared to)\b/.test(s.toLowerCase());
    if (shared > 0 || compareLink) linked.push(s);
  }
  return linked.length > 0 ? [...window, ...linked] : window;
}

function isAnswerableQuizQuestion(
  question: string,
  options: string[],
  answer: string,
  context: string
): boolean {
  if (!context || options.length !== 3) return false;
  const candidateWindow = linkAnswerSentences(
    String(question || ""),
    String(answer || ""),
    context,
    answerCandidateSentences(String(question || ""), context)
  );
  if (candidateWindow.length === 0) return false;
  const supports = options.map((opt) => optionSupport(opt, candidateWindow));
  const maxSupport = Math.max(...supports);
  // (a) Q1-type: no option answers the stem — the correct fact is missing.
  if (maxSupport < 0.3) {
    console.error(
      `[quiz] Unanswerable: no option matches the question's answer sentence (best ${maxSupport.toFixed(2)}): ${String(question).slice(0, 80)}`
    );
    return false;
  }
  // (b) The marked answer must BE a best-matching option, not a distractor.
  const answerSupport = optionSupport(String(answer || ""), candidateWindow);
  if (answerSupport + 0.05 < maxSupport) {
    console.error(
      `[quiz] Unanswerable: answer "${String(answer).slice(0, 40)}" (support ${answerSupport.toFixed(2)}) is not the best-supported option (${maxSupport.toFixed(2)})`
    );
    return false;
  }
  // (c) Q5-type guard: options must discriminate ON the stem's answer
  // sentence — if every option matches IT equally there is no single
  // correct answer. Measured on candidateWindow[0] alone: within the wider window
  // each option is supported by its own sentence, which says nothing
  // about discrimination.
  const answerSentence = [candidateWindow[0]];
  const topSupports = options.map((opt) => optionSupport(opt, answerSentence));
  const topMax = Math.max(...topSupports);
  const topMin = Math.min(...topSupports);
  if (topMax > 0.5 && topMax - topMin < 0.1) {
    console.error(`[quiz] Unanswerable: options do not discriminate: ${String(question).slice(0, 80)}`);
    return false;
  }
  return true;
}

function quizAnswerableInContext(quiz: unknown, context: string): boolean {
  if (!Array.isArray(quiz) || quiz.length === 0) return false;
  return quiz.every((entry) => {
    const q = entry as { options?: unknown; answer?: unknown; question?: unknown };
    const options = Array.isArray(q?.options)
      ? q.options.filter((opt): opt is string => typeof opt === "string")
      : [];
    const answer = typeof q?.answer === "string" ? q.answer : String(q?.answer ?? "");
    const question = typeof q?.question === "string" ? q.question : String(q?.question ?? "");
    return isAnswerableQuizQuestion(question, options, answer, context);
  });
}

function pickAnswerForQuestion(question: string, options: string[], context: string): string {
  const qWords = expandQuizSynonyms(quizContentWords(question));
  const sentences = String(context || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) {
    // No context: prefer the option that does NOT echo the stem.
    let best = options[0];
    let bestScore = Infinity;
    for (const opt of options) {
      const s = echoScore(question, [opt]);
      if (s < bestScore) {
        bestScore = s;
        best = opt;
      }
    }
    return best;
  }
  // Top sentence = most overlap with (synonym-expanded) question words.
  let top = sentences[0];
  let topScore = -1;
  for (const s of sentences) {
    const sSet = new Set(quizContentWords(s));
    const hits = [...qWords].filter((w) => sSet.has(w)).length;
    if (hits > topScore) {
      topScore = hits;
      top = s;
    }
  }
  const topSet = new Set(quizContentWords(top));
  let best = options[0];
  let bestScore = -1;
  for (const opt of options) {
    const oWords = quizContentWords(opt);
    if (oWords.length === 0) continue;
    const hits = oWords.filter((w) => topSet.has(w)).length;
    const score = hits / oWords.length;
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return best;
}

// Options for little kids must read alone: no bare verb phrases such as
// "Make the leaves bigger" or "Travel from the roots". Those are fragments
// that belong to a different question stem (the reported plants-seed swap).
const BARE_VERB_START = /^(make|makes|travel|travels|stay|stays|disappear|disappears|grow|grows|get|gets|put|puts|take|takes|go|goes|come|comes)\b/i;

// Does the stem ask for an ACTION? "What does warm air do?" → an option
// like "Stay the same temperature" is a complete elliptical answer, not a
// fragment. Stems expecting a noun ("What is the closest layer?") do not
// match, so a stray verb option there still gets rejected.
function stemExpectsAction(stem: string): boolean {
  const s = String(stem || "").toLowerCase();
  if (!s.includes("?")) return false;
  if (/\bwhat\b[^?]*\bdo(es)?\b[^?]*\bdo\b/.test(s)) return true;
  if (/\bdo(es)?\b[^?]*\bwhat\?\s*$/.test(s)) return true;
  return /^(what|how|why)\b[^?]*\b(happen|happens|make|makes|change|changes|grow|grows|become|becomes|cause|causes|produce|produces)\b/.test(s);
}

function isFragmentOption(opt: string, stem = ""): boolean {
  const t = String(opt || "").trim();
  if (!t) return true;
  if (/^[a-z]/.test(t)) return true;
  if (BARE_VERB_START.test(t) && !/^(it|they|he|she|we|the|a|plants?|roots?|seeds?|leaves?)\b/i.test(t)) {
    return !stemExpectsAction(stem);
  }
  return false;
}

// Repair swapped option sets: if question A fits question B's options
// better than its own (and vice versa), swap them back. Answers travel
// with re-derivation from context so they stay valid + grounded.
// Uses echo AND per-question grounding so fragment sets like
// "Make the leaves bigger / Travel from the roots" get caught even when
// echo scores are both low.
function optionGrounding(question: string, options: string[], context: string): number {
  const q = quizContentWords(question).join(" ");
  const c = String(context || "");
  let best = 0;
  for (const opt of options) {
    best = Math.max(best, quizGroundingScore(`${q} ${opt}`, [], String(opt), c));
  }
  return best;
}

function fixSwappedQuizOptions(quiz: FallbackQuizQuestion[], context = ""): FallbackQuizQuestion[] {
  if (!Array.isArray(quiz) || quiz.length < 2) return quiz;
  const fixed = quiz.map((q) => ({ ...q }));
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      const qi = String(fixed[i].question || "");
      const qj = String(fixed[j].question || "");
      const oi = Array.isArray(fixed[i].options) ? fixed[i].options : [];
      const oj = Array.isArray(fixed[j].options) ? fixed[j].options : [];
      if (oi.length !== 3 || oj.length !== 3) continue;
      const currentEcho = echoScore(qi, oi) + echoScore(qj, oj);
      const swappedEcho = echoScore(qi, oj) + echoScore(qj, oi);
      const currentGround = optionGrounding(qi, oi, context) + optionGrounding(qj, oj, context);
      const swappedGround = optionGrounding(qi, oj, context) + optionGrounding(qj, oi, context);
      const currentFrag = oi.filter((opt) => isFragmentOption(opt)).length + oj.filter((opt) => isFragmentOption(opt)).length;
      // Re-assign options to whichever question they ground better.
      const oiFitsJ = optionGrounding(qj, oi, context);
      const ojFitsI = optionGrounding(qi, oj, context);
      const oiFitsI = optionGrounding(qi, oi, context);
      const ojFitsJ = optionGrounding(qj, oj, context);
      const crossBetter = oiFitsJ > oiFitsI + 0.1 && ojFitsI > ojFitsJ + 0.1;
      // Answerability swap (the reported Q1/Q5 atmosphere bug): Q1 holds
      // weather-description options while Q5 holds the layer names, so each
      // question's own options match the OTHER question's answer sentence.
      // Compare per-question best-option support against each question's own
      // top context sentence — whole-context grounding is too coarse to see it.
      const currentSupport =
        questionBestSupport(qi, oi, context) + questionBestSupport(qj, oj, context);
      const swappedSupport =
        questionBestSupport(qi, oj, context) + questionBestSupport(qj, oi, context);
      // Swap on a clear echo improvement OR a clear grounding improvement OR
      // a clear answerability improvement, so good quizzes are untouched but
      // swapped fragment sets are fixed. NEVER when total support degrades —
      // echo/grounding can look "better" for an assignment that separates
      // each question from its own answer sentence (observed support
      // 2.00 -> 0.67 while the swap was still accepted via echo).
      const supportOk = swappedSupport >= currentSupport - 0.15;
      if (supportOk && (swappedEcho + 0.15 < currentEcho || swappedGround > currentGround + 0.2 || crossBetter || swappedSupport > currentSupport + 0.3)) {
        // Never swap into a worse fragment situation.
        const fragAfterSwap = oj.filter((opt) => isFragmentOption(opt)).length + oi.filter((opt) => isFragmentOption(opt)).length;
        void currentFrag;
        void fragAfterSwap;
        console.error(
          `[quiz] swapping options between Q${i} and Q${j} (echo ${currentEcho.toFixed(2)} -> ${swappedEcho.toFixed(2)}, ground ${currentGround.toFixed(2)} -> ${swappedGround.toFixed(2)}, support ${currentSupport.toFixed(2)} -> ${swappedSupport.toFixed(2)})`
        );
        const tmp = fixed[i].options;
        fixed[i].options = fixed[j].options;
        fixed[j].options = tmp;
        // Re-derive answers from context so they match the new options.
        fixed[i].answer = pickAnswerForQuestion(qi, fixed[i].options, context);
        fixed[j].answer = pickAnswerForQuestion(qj, fixed[j].options, context);
      }
    }
  }
  return fixed;
}

function fixQuizAnswers(quiz: FallbackQuizQuestion[]): FallbackQuizQuestion[] {
  // Try to fix answers that are close to options (typos). Inputs arrive
  // validated (safeParseQuiz / manual parse / fallback), so question,
  // options, and answer are strings here.
  return quiz.map((q) => {
    const { answer, options } = q;
    const normalizedOptions = Array.isArray(options) ? options.filter((opt) => typeof opt === "string") : [];
    const normalizedAnswer = answer;

    if (normalizedOptions.length === 0) {
      return q;
    }

    if (normalizedOptions.includes(normalizedAnswer)) {
      return {
        ...q,
        answer: normalizedAnswer || normalizedOptions[0]
      };
    }

    let bestMatch = normalizedOptions[0];
    let bestScore = 0;

    for (const option of normalizedOptions) {
      const lowerAnswer = normalizedAnswer.toLowerCase();
      const lowerOption = option.toLowerCase();

      if (lowerAnswer === lowerOption) {
        bestMatch = option;
        break;
      }

      const answerWords = lowerAnswer.split(/\s+/);
      const optionWords = lowerOption.split(/\s+/);
      const commonWords = answerWords.filter((w: string) => optionWords.includes(w)).length;
      const score = commonWords / Math.max(answerWords.length, optionWords.length);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = option;
      }
    }

    return {
      ...q,
      // Snap a near-miss answer into the options ONLY on strong word
      // overlap. A weak/no match means no option actually answers the stem
      // (the reported Q1-type bug) — keep the answer as-is so format
      // validation fails and the retry/fallback path triggers instead of
      // masking a broken quiz with a wrong-but-plausible answer.
      answer: bestScore > 0.5 ? bestMatch : normalizedAnswer
    };
  });
}

// Re-derive a wrongly-marked answer when the correct option IS present but
// the model picked a distractor: point the answer at the option best
// supported by the question's own answer sentence. When NO option is
// supported (Q1-type: correct fact missing from the options) this cannot
// help — the question stays unanswerable so validation rejects it.
function fixQuizAnswerability(quiz: FallbackQuizQuestion[], context = ""): FallbackQuizQuestion[] {
  if (!Array.isArray(quiz) || !context) return quiz;
  return quiz.map((q) => {
    const question = String(q?.question || "");
    const options = Array.isArray(q?.options) ? q.options : [];
    const answer = typeof q?.answer === "string" ? q.answer : String(q?.answer ?? "");
    if (!question || options.length !== 3) return q;
    if (isAnswerableQuizQuestion(question, options, answer, context)) return q;
    if (questionBestSupport(question, options, context) < 0.3) return q;
    return { ...q, answer: pickAnswerForQuestion(question, options, context) };
  });
}

function validateQuizFormat(quiz: unknown, expectedCount?: number): boolean {
  if (!Array.isArray(quiz)) {
    console.error("[quiz] Invalid format: quiz is not an array");
    return false;
  }

  if (quiz.length === 0) {
    console.error("[quiz] Invalid format: quiz is empty");
    return false;
  }

  if (typeof expectedCount === "number" && quiz.length !== expectedCount) {
    console.error(`[quiz] Invalid format: got ${quiz.length} questions, expected ${expectedCount}`);
    return false;
  }
  
  return quiz.every((q: unknown, idx) => {
    if (!q || typeof q !== "object") {
      console.error(`[quiz] Question ${idx}: missing 'question' field`);
      return false;
    }
    const item = q as { question?: unknown; options?: unknown; answer?: unknown };
    // Check required fields exist
    if (!item.question) {
      console.error(`[quiz] Question ${idx}: missing 'question' field`);
      return false;
    }
    if (!item.options) {
      console.error(`[quiz] Question ${idx}: missing 'options' field`);
      return false;
    }
    if (!item.answer) {
      console.error(`[quiz] Question ${idx}: missing 'answer' field`);
      return false;
    }
    
    // Check types
    if (typeof item.question !== "string") {
      console.error(`[quiz] Question ${idx}: 'question' is not a string`);
      return false;
    }
    if (!Array.isArray(item.options)) {
      console.error(`[quiz] Question ${idx}: 'options' is not an array`);
      return false;
    }
    if (typeof item.answer !== "string") {
      console.error(`[quiz] Question ${idx}: 'answer' is not a string`);
      return false;
    }
    
    // Check options are all strings
    if (!item.options.every((opt: unknown) => typeof opt === "string")) {
      console.error(`[quiz] Question ${idx}: not all options are strings`);
      return false;
    }
    const options = item.options.filter((opt): opt is string => typeof opt === "string");
    
    // Check exactly 3 options
    if (options.length !== 3) {
      console.error(`[quiz] Question ${idx}: has ${options.length} options, need exactly 3`);
      return false;
    }
    
    // Check for duplicate options
    const uniqueOptions = new Set(options.map((opt) => opt.trim().toLowerCase()));
    if (uniqueOptions.size !== 3) {
      console.error(`[quiz] Question ${idx}: has duplicate options [${options.map((o) => `"${o}"`).join(", ")}]`);
      return false;
    }
    
    // Check answer is in options
    if (!options.includes(item.answer)) {
      console.error(`[quiz] Question ${idx}: answer "${item.answer}" not in options [${options.map((o) => `"${o}"`).join(", ")}]`);
      return false;
    }
    
    return true;
  });
}

function countBraceBalance(text: string) {
  let inString = false;
  let escaped = false;
  let balance = 0;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") balance += 1;
    if (char === "}") balance -= 1;
  }

  return balance;
}

function extractFirstJsonArray(text: string) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (start === -1 && char === "[") {
      start = i;
      depth = 1;
      continue;
    }

    if (start !== -1) {
      if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

// The model reliably writes two questions with the SAME three options in one
// quiz (e.g. two layer-name questions on weather, both answered "the
// troposphere"). Exactly one duplicate is repairable: drop it and keep the
// shorter quiz instead of regenerating everything and landing on fallback
// templates. More than one duplicate means a degenerate response — return it
// unchanged so the variety gate rejects it and the retry runs.
function dedupeOptionSetDuplicates(quiz: FallbackQuizQuestion[] | null): { quiz: FallbackQuizQuestion[] | null; dropped: number } {
  if (!Array.isArray(quiz) || quiz.length < 2) return { quiz, dropped: 0 };
  const seen = new Set<string>();
  const kept: FallbackQuizQuestion[] = [];
  for (const item of quiz) {
    const key = Array.isArray(item?.options)
      ? item.options.map((opt) => String(opt).toLowerCase().trim()).sort().join("|")
      : "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    kept.push(item);
  }
  const dropped = quiz.length - kept.length;
  if (dropped !== 1 || kept.length < 2) return { quiz, dropped: 0 };
  console.log(`[quiz] dropped 1 duplicate-option-set question, ${kept.length} remain`);
  return { quiz: kept, dropped: 1 };
}

function hasQuizVariety(quiz: unknown): boolean {
  if (!Array.isArray(quiz) || quiz.length < 2) return true;

  const normalizedQuestions = quiz.map((item) =>
    String((item as { question?: unknown } | null)?.question || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
  if (new Set(normalizedQuestions).size !== normalizedQuestions.length) {
    console.error("[quiz] Rejected repeated question stems");
    return false;
  }

  if (quiz.some((item) => {
    const question = String((item as { question?: unknown } | null)?.question || "").trim();
    return /\bwhy is\b.*\b(?:helps|uses|has|have|does|are)\b/i.test(question)
      || /\bhow does\b.*\b(?:is|are|was|were|has|have)\b/i.test(question);
  })) {
    console.error("[quiz] Rejected grammatically malformed question stem");
    return false;
  }

  const optionSets = quiz.map((item) => {
    const entry = item as { options?: unknown } | null;
    return Array.isArray(entry?.options)
      ? entry.options.map((option: unknown) => String(option).toLowerCase().trim()).sort().join("|")
      : "";
  });
  if (new Set(optionSets).size !== optionSets.length) {
    console.error("[quiz] Rejected repeated option sets");
    return false;
  }

  // Citation boilerplate ("according to the lesson", "the lesson states")
  // repeats in nearly every stem — strip it before near-dup comparison or
  // two genuinely different questions look identical.
  const stripCitation = (text: string): string =>
    text
      .replace(/\b(according to|as stated in|as mentioned in|based on|from|in)\s+(the\s+)?(lesson|text|passage|paragraph|reading|story|article)s?\b/g, " ")
      .replace(/\bthe\s+(lesson|text|passage|paragraph|reading|story|article)s?\s+(states?|says?|mentions?|tells?\s+us|describes?|explains?|notes?)\b/g, " ");
  const questionWords = quiz.map((item) =>
    new Set(quizContentWords(stripCitation(String((item as { question?: unknown } | null)?.question || "").toLowerCase())))
  );
  for (let i = 0; i < questionWords.length; i++) {
    for (let j = i + 1; j < questionWords.length; j++) {
      const shared = [...questionWords[i]].filter((word) => questionWords[j].has(word));
      const smaller = Math.min(questionWords[i].size, questionWords[j].size);
      // smaller >= 2: a single-content-word stem ("What is weather?")
      // shares its only word with almost any other stem on the topic.
      if (smaller >= 2 && shared.length / smaller >= 0.8) {
        console.error("[quiz] Rejected near-duplicate question stems");
        return false;
      }
    }
  }
  return true;
}

function repairQuizJson(raw: string) {
  let cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/"""/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const arrayStart = cleaned.indexOf("[");
  if (arrayStart !== -1) {
    cleaned = cleaned.substring(arrayStart);
  }

  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayEnd !== -1) {
    cleaned = cleaned.substring(0, arrayEnd + 1);
  }

  // Convert single-quoted values to double-quoted values
  // This handles cases like: "answer": '1' -> "answer": "1"
  cleaned = cleaned.replace(/:\s*'([^']*?)'/g, ': "$1"');

  cleaned = cleaned
    .replace(/"reason"\s*:/g, '"answer":')
    .replace(/}\s*\{/g, '}, {')
    .replace(/}\s*,\s*"options"/g, ', "options"')
    .replace(/}\s*,\s*"answer"/g, ', "answer"')
    .replace(/"answer"\s*:\s*\[\s*"([^"]+?)"[^\]]*\]/g, '"answer":"$1"')
    .replace(/"\s*"(?=(options|answer)"\s*:)/g, '", "')
    .replace(/"\s*,\s*"\s*answer/g, '","answer')
    .replace(/\s*\[\s*,/g, '[')
    .replace(/,\s*\]/g, ']')
    .replace(/,\s*([\]}])/g, '$1')
    .trim();

  const balance = countBraceBalance(cleaned);
  if (balance > 0) {
    cleaned += "}".repeat(balance);
  }

  return cleaned;
}

function extractQuotedStrings(text: string) {
  const result: string[] = [];
  const regex = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    result.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }

  return result;
}

function parseQuizArrayManually(raw: string) {
  const cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const questionMatches = [...cleaned.matchAll(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)];
  const optionsMatches = [...cleaned.matchAll(/"options"\s*:\s*\[((?:[^\]]|\\.)*)\]/gi)];
  const answerMatches = [...cleaned.matchAll(/"answer"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|\[((?:[^\]]|\\.)*)\])/gi)];

  const objects: FallbackQuizQuestion[] = [];

  for (const questionMatch of questionMatches) {
    const question = questionMatch[1].replace(/\\"/g, '"').trim();
    const questionIndex = questionMatch.index ?? 0;
    if (!question) continue;

    const optionsEntry = optionsMatches.find((entry) => (entry.index ?? 0) > questionIndex);
    const answerEntry = answerMatches.find((entry) => (entry.index ?? 0) > questionIndex);

    const options = optionsEntry ? extractQuotedStrings(optionsEntry[1]) : [];
    let answer = answerEntry?.[1] ? answerEntry[1].replace(/\\"/g, '"').trim() : undefined;

    if (!answer && answerEntry?.[2]) {
      const arrayText = answerEntry[2];
      const arrayOptions = extractQuotedStrings(arrayText);
      answer = arrayOptions[0]?.trim();
    }

    if (options.length === 0) continue;

    const normalizedOptions = options.slice(0, 3);
    const normalizedAnswer = answer && normalizedOptions.includes(answer)
      ? answer
      : normalizedOptions[0];

    objects.push({
      question,
      options: normalizedOptions,
      answer: normalizedAnswer,
    });
  }

  return objects;
}

function safeParseQuiz(cleanedQuiz: string): FallbackQuizQuestion[] | null {
  try {
    const parsed: unknown = JSON.parse(cleanedQuiz);
    // Validate all questions
    if (Array.isArray(parsed) && parsed.every(isValidQuizQuestion)) {
      return parsed as FallbackQuizQuestion[];
    }
    console.error("[quiz] Parsed JSON but questions failed validation");
  } catch (error) {
    console.error("[quiz] JSON parse failed:", error);
  }

  const repaired = repairQuizJson(cleanedQuiz);
  const arrayText = extractFirstJsonArray(repaired) || extractFirstJsonArray(cleanedQuiz);

  if (arrayText) {
    try {
      const parsed: unknown = JSON.parse(arrayText);
      if (Array.isArray(parsed) && parsed.every(isValidQuizQuestion)) {
        return parsed as FallbackQuizQuestion[];
      }
      console.error("[quiz] extractFirstJsonArray parse succeeded but validation failed");
    } catch (arrayError) {
      console.error("[quiz] extractFirstJsonArray parse failed:", arrayError, "arrayText:", arrayText);
    }
  }

  try {
    const parsed: unknown = JSON.parse(repaired);
    if (Array.isArray(parsed) && parsed.every(isValidQuizQuestion)) {
      return parsed as FallbackQuizQuestion[];
    }
    console.error("[quiz] Repaired JSON parsed but validation failed");
  } catch (repairError) {
    console.error("[quiz] repair parse failed:", repairError, "repaired:", repaired);
  }

  const manual = parseQuizArrayManually(repaired);
  if (manual.length > 0 && manual.every(isValidQuizQuestion)) {
    return manual;
  }
  
  const manualOriginal = parseQuizArrayManually(cleanedQuiz);
  if (manualOriginal.length > 0 && manualOriginal.every(isValidQuizQuestion)) {
    return manualOriginal;
  }

  return null;
}

function normalizeRawQuiz(raw: string) {
  return raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/"""/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRawQuiz(raw: string) {
  let cleaned = normalizeRawQuiz(raw);
  const arrayStart = cleaned.indexOf("[");
  if (arrayStart !== -1) {
    cleaned = cleaned.substring(arrayStart);
  }

  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayEnd !== -1) {
    cleaned = cleaned.substring(0, arrayEnd + 1);
  }

  return cleaned;
}

function buildQuizRetryPrompt(raw: string, context: string, topic: string, age: number, numQuestions: number = 3, reason?: string) {
  let vocabularyGuidance = "";
  
  if (age < 7) {
    vocabularyGuidance = `
Use SIMPLE vocabulary appropriate for age ${age}:
- Use "Mom and Dad" instead of "Parents" or "Couple"
- Use "Big family" instead of "Large family"
- Use "Small family" not "Nuclear family"
- Avoid: couple, nuclear, joint, consist, usually`;
  } else if (age < 10) {
    vocabularyGuidance = `
Use CLEAR vocabulary appropriate for age ${age}:
- Can use "parents" and "family members"
- Can use "grandparents", "children", "siblings"
- Explain concepts clearly`;
  }

  return `The previous response was rejected: ${reason || "invalid questions"}.
Rewrite the FULL quiz as valid JSON, fixing exactly that problem while keeping every other rule below.

⚠️ CRITICAL RULES - FOLLOW STRICTLY:

1. LANGUAGE: Write ONLY in ENGLISH. Do NOT mix languages.
   ✗ DON'T: "¿Qué tipo..." (Spanish)
   ✓ DO: "What type..." (English only)

2. CONTENT SOURCE: Use ONLY information from the provided CONTEXT below.
   ✗ DON'T: Add facts from outside knowledge
   ✗ DON'T: Hallucinate information
   ✗ DON'T: Ask about a sub-topic the CONTEXT does NOT mention
   ✓ DO: Base every question AND every option on the CONTEXT provided
   ✓ DO: The CORRECT option must REPEAT the CONTEXT's exact words for the
     fact — copy, don't rephrase (write "takes up more space", not "expands")

3. QUESTIONS MUST BE QUESTIONS, NOT STATEMENTS:
   ✗ BAD: "A family makes a home" (statement)
   ✓ GOOD: "What does a family make?" (question)
   Questions MUST have a "?" and start with: What, Which, How, Who, Why, When, Where

4. NO BRACKETS IN OPTIONS:
   ✗ BAD: "(Small family)" or "[Small family]"
   ✓ GOOD: "Small family"

  5. EACH QUESTION MUST BE SPECIFIC about what it asks
5b. OPTIONS MUST READ STANDALONE — no meaningless bare verb fragments
    (a child reads an option alone):
    ✗ BAD: "Make the leaves bigger" / "Travel from the roots"
    ✓ GOOD: "The seed starts to grow" / "Warm air takes up more space"
    For action questions ("What does warm air do?") a clear verb phrase
    like "Stays the same temperature" is fine.
6. ONLY ONE option should be correct - others must be clearly FALSE
7. OPTIONS MUST BELONG TO THEIR OWN QUESTION AND ANSWER IT. Never copy an option set
    from one question onto another. Each question's options must use NEW
    words — an option must NOT repeat the question's key phrase.
    ✗ BAD: "Which family has one or two children?" + options: [One or two children, Five or more children, No children] (option just repeats the question!)
    ✓ GOOD: "Which family has one or two children?" + options: [Small family, Large family, Single parent household]
    ✗ BAD: "What's a big family like?" + options: [Small family, Large family, Just a house] (options copied from the other question!)
    ✓ GOOD: "What's a big family like?" + options: [Has many children, Has no children, Is just a house]
    ✗ BAD (unanswerable): "What layer do humans live in?" + options: [The distance to the sun, The colors of clouds, The different ways we experience weather] (NO option is the layer!)
    ✓ GOOD: "What layer do humans live in?" + options: [The troposphere, The mesosphere, The stratosphere]
    ✗ BAD (mismatched): "What do weather words tell us?" + options: [The mesosphere, The stratosphere, The troposphere] (layer names cannot answer a weather-words question!)
    The correct "answer" MUST appear word-for-word as one of the 3 options.
8. Use vocabulary appropriate for age ${age}
${vocabularyGuidance}

 Invalid response:
${raw}

CONTEXT (your only source of facts — every question and answer must come from it):
${context}

Examples of GOOD questions:
✗ "Which describes a family?" + options: [one child, one or two children, many children] - all are valid!
✓ "What family has one or two children?" + options: [Small family, Large family, Just one child] - only one is correct!

✗ "A family makes a home" - this is a STATEMENT, not a question!
✓ "What makes a home?" - this IS a QUESTION!

Return EXACTLY one JSON array with exactly ${numQuestions} question objects:
[
  {"question":"...","options":["option1","option2","option3"],"answer":"option1"},
  {"question":"...","options":["option1","option2","option3"],"answer":"option2"}
  ...repeat until ${numQuestions} total questions...
]

CRITICAL RULES:
- Return EXACTLY ${numQuestions} questions
- Questions MUST be specific and clear
- ONLY ONE option is truly correct
- Other options must be clearly FALSE (not alternative correct answers)
- Use vocabulary for age ${age}
- Use DOUBLE QUOTES (") for all strings, NEVER single quotes (')
- No markdown, no comments, no backticks
If you cannot produce valid JSON, return [];`;
}

function isValidQuizQuestion(question: unknown): question is FallbackQuizQuestion {
  if (!question || typeof question !== "object") return false;
  const candidate = question as { question?: unknown; options?: unknown; answer?: unknown };
  if (typeof candidate.question !== "string" || !candidate.question.trim()) return false;
  if (!Array.isArray(candidate.options)) return false;
  // All options must be non-empty strings; filter narrows to string[] so the
  // checks below operate on the validated shape.
  const options = candidate.options.filter(
    (opt): opt is string => typeof opt === "string" && opt.trim().length > 0
  );
  if (options.length !== 3) return false;
  if (typeof candidate.answer !== "string" || !candidate.answer.trim()) return false;

  // Check that question is actually a question, not a statement.
  // The age >= 10 prompt encourages citing the source, so strip leading
  // attributions before testing the starter — "According to the lesson,
  // where does the troposphere ...?" is a valid question.
  const questionText = candidate.question.trim();
  const stripped = questionText
    .replace(/^(?:according to|based on|from|in|as (?:stated|mentioned|described|written|noted) in)\s+(?:the\s+)?(?:lesson|text|passage|paragraph|reading|story|article|book)s?\s*[,:;\-–—]*\s*/i, "")
    .replace(/^(?:the\s+)?(?:lesson|text|passage|paragraph|reading|story|article|book)\s+(?:states?|says?|mentions?|tells?\s+us|describes?|explains?|notes?)\s*(?:that\s+)?[,:;\-–—]*\s*/i, "")
    .trim();
  const questionStarters = ["What", "Which", "How", "Who", "Why", "When", "Where", "Can", "Do", "Does", "Is", "Are"];
  const startsWithQuestion = questionStarters.some(starter =>
    stripped.toLowerCase().startsWith(starter.toLowerCase())
  );
  // Also accept mid-sentence questions after attribution stripping
  // ("The lesson states that warm air does what?").
  const asksInline = stripped.endsWith("?") && /\b(?:what|which|where|when|why|how|who)\b/i.test(stripped);
  if (!questionText.includes("?") || (!startsWithQuestion && !asksInline)) {
    console.error("[quiz] Invalid: not a proper question:", questionText);
    return false;
  }

  // Check options have no brackets (all are non-empty strings already)
  for (const opt of options) {
    if (/[\(\)\[\]\{\}]/.test(opt)) {
      console.error("[quiz] Invalid: option contains brackets:", opt);
      return false;
    }
  }

  // Reject fragment options that cannot stand alone
  // (reported bug: "Make the leaves bigger", "Travel from the roots").
  // Stem-aware: verb options are fine when the stem asks for an action.
  for (const opt of options) {
    if (isFragmentOption(String(opt), questionText)) {
      console.error("[quiz] Invalid: fragment option:", opt);
      return false;
    }
  }

  // Reject subject-verb mismatch the small model emits
  // ("What does the plant roots do?" -> should be "do ... roots do?").
  if (/\bwhat does\b[^?]*\b(roots|leaves|plants|seeds|trunks|elephants|animals)\b[^?]*\bdo\b/i.test(questionText)) {
    console.error("[quiz] Invalid: does + plural mismatch:", questionText);
    return false;
  }

  // Check for duplicate options
  const uniqueOptions = new Set(options.map((opt) => opt.trim().toLowerCase()));
  if (uniqueOptions.size !== 3) {
    console.error("[quiz] Invalid: duplicate options detected");
    return false;
  }

  // Check that answer is one of the options
  const answerTrimmed = candidate.answer.trim();
  const hasAnswer = options.some(
    (opt) => opt.trim().toLowerCase() === answerTrimmed.toLowerCase()
  );
  if (!hasAnswer) {
    console.error("[quiz] Invalid: answer not in options");
    return false;
  }

  return true;
}

function buildQuizPrompt(
  context: string,
  topic: string,
  age: number,
  numQuestions: number = 3,
  lessonText = ""
) {
  let ageGuidance = "";
  let vocabularyGuidance = "";
  
  if (age < 7) {
    ageGuidance = "Use VERY simple words. Short sentences (5-8 words max). Ask about obvious facts.";
    vocabularyGuidance = `
Use SIMPLE vocabulary appropriate for age ${age}:
- Use "Mom and Dad" instead of "Parents"
- Use "Mom and Dad" instead of "Couple"
- Use "Grandma and Grandpa" instead of "Grandparents"
- Use "Brother and Sister" or "Siblings" instead of "Siblings"
- Use "Big family" instead of "Large family"
- Use "Small family" instead of "Nuclear family"
- Use "Uncles and Aunts" clearly explained
- Avoid: couple, nuclear, joint, consist, usually
- Use: has, includes, made of, lives with`;
  } else if (age < 10) {
    ageGuidance = "Use clear, everyday language. Medium sentences (8-12 words). Ask about facts and simple definitions.";
    vocabularyGuidance = `
Use CLEAR vocabulary appropriate for age ${age}:
- Can use "parents" but also say "mom and dad"
- Can use "family" and "members"
- Can use "grandparents" clearly
- Can use "children" and "siblings"
- Avoid complex words: joint, nuclear, extended
- Explain concepts simply`;
  } else {
    ageGuidance = "Use proper terms. Can have longer sentences. Ask about concepts and relationships.";
    vocabularyGuidance = `Use age-appropriate vocabulary and concepts for age ${age}:
- Can use: family types, members, generations, extended, nuclear, joint
- Explain relationships clearly`;
  }

  return `You are a quiz creator for a ${age}-year-old child. ${ageGuidance}

⚠️ CRITICAL RULES - FOLLOW STRICTLY:

1. LANGUAGE: Write ONLY in ENGLISH. Do NOT mix languages or translate to other languages.
   ✗ DON'T: "¿Qué tipo de familia..." (Spanish)
   ✓ DO: "What type of family..." (English)

2. CONTENT SOURCE: Use ONLY information from the provided CONTEXT below.
   ✗ DON'T: Add facts from outside knowledge
   ✗ DON'T: Hallucinate or guess information
   ✗ DON'T: Ask about a sub-topic that the CONTEXT does NOT mention
      (e.g. do not ask about "African elephants" if the CONTEXT only talks
      about elephants in general)
   ✓ DO: Base every question AND every option on the CONTEXT text
   ✓ DO: Use the CONTEXT's own words where you can
   ✓ DO: The CORRECT option must REPEAT the CONTEXT's exact words for the
     fact — copy, don't rephrase (write "takes up more space", not "expands")

3. QUESTIONS MUST BE QUESTIONS, NOT STATEMENTS:
   ✗ BAD: "A family makes a home" (statement)
   ✗ BAD: "Families are important" (statement)
   ✓ GOOD: "What does a family do?" (question)
   ✓ GOOD: "Why are families important?" (question)
   Questions MUST start with: What, Which, How, Who, Why, When, Where

4. COVERAGE: Every question must test a different fact or idea from the CONTEXT.
  Do not repeat the same question stem with a different sentence as an option.
  For this topic, prefer specific details, actions, reasons, and vocabulary from
  the lesson instead of asking what the lesson is generally about.

5. OPTIONS MUST NOT HAVE BRACKETS:
   ✗ BAD: "(Small family)" or "[Small family]" or "{Small family}"
   ✓ GOOD: "Small family"
   Remove all brackets, parentheses, and braces from options!

CRITICAL: VOCABULARY RULES FOR AGE ${age}:
${vocabularyGuidance}

Output must be valid JSON only. Do not include any markdown, explanation, or extra text.

Return EXACTLY one JSON array. It must start with '[' and end with ']'.
Do not return anything else.

The array must contain exactly ${numQuestions} objects. Each object must contain only these keys:
- question
- options
- answer

CRITICAL RULES FOR QUESTIONS:
1. Questions MUST be CLEAR and EXPLICIT. State exactly WHAT is being asked.
   BAD: "Which of these is correct?" (vague)
   GOOD: "What family size has one or two children?" (specific)

2. Questions MUST have ONE UNAMBIGUOUS correct answer.
   BAD: "Which describes a family?" + options: [one child, one or two children, many children] - ALL are valid families!
   GOOD: "What family size has one or two children?" + options: [Small family, Large family, Just one person] - Only one correct!

3. Questions must avoid options that are ALL true — exactly ONE option is correct:
   BAD: "What does a family usually consist of?" + options: [Single parent, Couple with children, Just parents] - confusing!
   GOOD: "What can a family include?" + options: [Parents with children, Just a house, Only pets] - only one is correct!

4. NEVER use "All of the above", "None of the above", or "None of these".
   Always give 3 concrete options so exactly one is correct.

5. NEVER ask vague questions. Be SPECIFIC about what you're testing:
   ✓ "Who lives in a small family?"
   ✓ "What family includes grandparents?"
   ✓ "How many children are in a small family?"
   ✓ "What can a family have?"
   ✗ "Which of these is correct?"
   ✗ "What is a family?"
   ✗ "What is the main subject of this quiz?" (meta question - NEVER ask this)
   ✗ "Which topic is this quiz about?" (meta question - NEVER ask this)
   ✗ "What was this quiz intended to teach?" (meta question - NEVER ask this)

  5b. OPTIONS MUST BELONG TO THEIR OWN QUESTION — never swap option sets
     between questions, and no option may just repeat the question stem. The
     correct answer MUST appear word-for-word among the 3 options, and every
     option must be a plausible answer to THIS stem (layer names for a
     "what layer" question, weather descriptions for a "what does weather
     tell us" question — never mix the two):
    ✗ BAD: "Which family has one or two children?" + [One or two children, Five or more children, No children] (option repeats the question!)
    ✓ GOOD: "Which family has one or two children?" + [Small family, Large family, Single parent household]
    ✗ BAD: "What's a big family like?" + [Small family, Large family, Just a house] (options copied from the other question!)
    ✓ GOOD: "What's a big family like?" + [Has many children, Has no children, Is just a house]
    ✗ BAD (swapped/fragment): "What does the plant roots do with the water?" + [It stays hard, It starts to grow, It disappears] (options answer "what happens to a seed", not "what roots do")
    ✓ GOOD: "What do the roots do?" + [Drink water from the soil, Make sunlight, Eat leaves] (each option answers THIS question)
    ✗ BAD (fragment): options like [Make the leaves bigger, Travel from the roots, Make the seeds grow] (bare verb phrases a child cannot read alone)
    ✓ GOOD: options like [The seed starts to grow, The seed stays hard, The seed disappears] (each option has a subject + verb)

  5c. GRAMMAR: Every question must sound natural when read aloud.
    Do not combine incompatible forms such as "Why is ... helps" or
    "How does ... is". Use "Why does ... help?" or "How is ... described?".
    Match subject and verb: "What DO the roots DO?" (plural) vs
    "What DOES the root DO?" (singular). Never write "What does the roots do?".
    Every option must start with a capital letter and read as a full phrase
    a child understands alone. Prefer giving the subject (The seed ...,
    The roots ..., Warm air ...). For action questions ("What does X do?")
    a clear verb phrase is fine (Stays the same temperature). Never write a
    meaningless bare fragment (Make the leaves bigger, Travel from the roots).
    Prefer the CONTEXT's own simple words. Keep each option to 2-6 words.
    Do not reuse the exact same three options for multiple questions.

6. Each question must have EXACTLY 3 options (concrete — never "All of the above").
7. EXACTLY ONE option is correct.
8. The answer MUST exactly match one of the 3 options exactly.

The question value must be a string.
The options value must be an array of exactly 3 strings.
The answer value must be a single string exactly matching one of the options.

IMPORTANT: Use DOUBLE QUOTES (") for ALL string values, NEVER use single quotes (').

EXAMPLES OF EXCELLENT QUESTIONS (age-appropriate and unambiguous):

For a 6-year-old about families:
Example (definitional questions):
[{"question":"What usually makes a family?","options":["Mom and Dad with kids","Just toys","Just a house"],"answer":"Mom and Dad with kids"},{"question":"How many kids are in a small family?","options":["One or two children","Five or more children","No children"],"answer":"One or two children"}]

For a 9-year-old about families:
Example (category questions):
[{"question":"Which family type has only parents and one or two children?","options":["Small family","Large family","Single parent household"],"answer":"Small family"}]

Notice:
- NEVER use "All of the above" — three concrete options, exactly one correct
- Each question is SPECIFIC about what it asks
- Only ONE option is clearly correct
- Vocabulary matches the age
- Language is simple and clear

Rules:
- Exactly ${numQuestions} questions
- Each VERY SPECIFIC about what is being asked
- Exactly 3 DIFFERENT options per question
- Only ONE option is correct - other two must be clearly FALSE
- All vocabulary appropriate for age ${age}
- No ambiguous questions where multiple options could be correct
- ALWAYS use double quotes, never single quotes
- No extra keys, no reason, no explanation, no comments
- No trailing commas
- No nested arrays except the options array
- Base questions DIRECTLY on the provided context

 CONTEXT:
${context}
${lessonText ? `\nMOST RECENT LESSON SHOWN TO THE CHILD (quiz ONLY facts the child already read here):\n${lessonText}\n\nQUIZ SOURCE RULE: every question AND every option must come from the LESSON above. If the LESSON does not contain enough distinct facts for ${numQuestions} questions, ask fewer distinct-fact questions and fill the rest from the LESSON's own sentences — never import new facts from CONTEXT that the LESSON did not teach.\n` : `\nQUIZ SOURCE RULE: every question must test a fact stated in CONTEXT.\n`}
NOW create ${numQuestions} quiz questions about ${topic}.
REMEMBER: Be SPECIFIC. Make sure only ONE option is clearly correct. Use vocabulary for age ${age}:`;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  console.log("[quiz] POST request started");
  
  // Check if streaming is requested
  const url = new URL(req.url);
  const stream = url.searchParams.get("stream") === "true";
  
  const body = await req.json();
  const { topic, age = 5, numQuestions: rawNumQuestions = 3, lessonText: rawLesson = "" } = body;
  const lessonText = typeof rawLesson === "string" ? rawLesson.trim().slice(0, 2000) : "";
  // Per-child isolation: verify ownership before retrieval. Client-supplied
  // lessonText is untrusted lesson-anchoring input (ownership enforced in the
  // client store, Stage 4); retrieval below is always child-scoped regardless.
  const verified = await verifyChildOwnership(req, body.childId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }
  // Clamp to the same 1-10 range the UI allows so "4" is always respected.
  const parsedCount = parseInt(String(rawNumQuestions), 10);
  const numQuestions = Number.isFinite(parsedCount)
    ? Math.max(1, Math.min(10, parsedCount))
    : 3;

  const retrievalStart = Date.now();
  // Fetch extra chunks for quiz so small lessons still yield enough distinct facts.
  // Teach from prose: the worksheet's own questions otherwise get copied verbatim
  // as quiz "questions" that are really statements ("A large family has ...").
  // Scoped to the verified child BEFORE scoring (see lib/retrieval.ts).
  const context = toTeachingText(await getRelevantContext(topic, 5, 0.30, { childId: verified.childId }));
  const retrievalTime = Date.now() - retrievalStart;
  console.log(`[quiz] RAG retrieval took ${retrievalTime}ms`);
  if (lessonText) console.log(`[quiz] anchored to lesson text (${lessonText.length} chars)`);
  // Grounding source: when the caller passes the displayed lesson, quiz ONLY it.
  const groundingSource = lessonText || context;
  
  if (!context || context.trim().length === 0) {
    console.log(`[quiz] No context found, total time: ${Date.now() - startTime}ms`);
    return NextResponse.json({
      quiz: "I don't know. Please ask a parent to add more information."
    });
  }

  const prompt = buildQuizPrompt(context, topic, age, numQuestions, lessonText);
  
  if (stream) {
    // For quiz, stream the raw response and accumulate JSON
    const encoder = new TextEncoder();
    const customReadable = new ReadableStream({
      async start(controller) {
        try {
          const llmStart = Date.now();
          let fullResponse = "";
          for await (const chunk of generateAnswerStream(prompt, 2000)) {
            fullResponse += chunk;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
          const llmTime = Date.now() - llmStart;
          const totalTime = Date.now() - startTime;
          
          // Clean the response aggressively
          let cleanedQuiz = fullResponse
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .replace(/"""/g, '"') // Replace triple quotes
            .replace(/,\s*"\s+"/g, '","') // Fix ], " " patterns
            .replace(/"\s*,\s*"\s*answer/g, '","answer') // Fix extra quotes before answer
            .replace(/\n\s*/g, " ") // Replace newlines and spaces
            .trim();

          // Extract JSON array
          if (!cleanedQuiz.startsWith("[")) {
            const arrayStart = cleanedQuiz.indexOf("[");
            if (arrayStart !== -1) {
              cleanedQuiz = cleanedQuiz.substring(arrayStart);
            }
          }

          // Find the end of the JSON array
          if (cleanedQuiz.includes("]")) {
            const arrayEnd = cleanedQuiz.lastIndexOf("]");
            cleanedQuiz = cleanedQuiz.substring(0, arrayEnd + 1);
          }

          try {
            let parsed = safeParseQuiz(cleanedQuiz);
            if (parsed) {
              // Un-swap option sets first (answers travel with re-derivation),
              // then snap answers into the (possibly swapped) options and
              // re-derive wrongly-marked answers when the right option exists.
              parsed = fixQuizAnswerability(
                fixQuizAnswers(fixSwappedQuizOptions(parsed, groundingSource)),
                groundingSource
              );
              cleanedQuiz = JSON.stringify(parsed);
            } else {
              console.error("[quiz] streaming parse failed, raw:", cleanedQuiz);
            }
          } catch (e) {
            console.error("[quiz] streaming parse error:", e, "raw:", cleanedQuiz);
          }
          
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, quiz: cleanedQuiz, _timing: { totalTime, retrievalTime, llmTime } })}\n\n`));
          controller.close();
        } catch (error) {
          console.error("[quiz] streaming error:", error);
          controller.error(error);
        }
      }
    });

    return new NextResponse(customReadable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }
  
  // Non-streaming response (original behavior)
  // Scale the token budget with the requested count so asking for 4+ questions
  // is not cut off mid-JSON (a common cause of falling back to 3 questions).
  const tokenBudget = Math.max(1200, Math.min(4000, 500 + numQuestions * 450));
  const llmStart = Date.now();
  const quiz = await generateAnswer(prompt, tokenBudget);
  const llmTime = Date.now() - llmStart;
  console.log(`[quiz] LLM generation took ${llmTime}ms`);

  const cleanedQuiz = cleanRawQuiz(quiz);
  let parsed = safeParseQuiz(cleanedQuiz);
  // One duplicate option set is repaired (dropped) rather than rejected; the
  // final count check then accepts numQuestions - 1 for that response.
  const firstDedupe = dedupeOptionSetDuplicates(parsed);
  parsed = firstDedupe.quiz;
  let dedupedShort = firstDedupe.dropped === 1;

  const gateFailure = (q: unknown): string | null =>
    !q ? "parse"
    : !hasQuizVariety(q) ? "variety"
    : !quizGroundedInContext(q, groundingSource) ? "grounding"
    : !quizAnswerableInContext(q, groundingSource) ? "answerability"
    : null;
  const GATE_REASONS: Record<string, string> = {
    parse: "a question or its options were invalid (bad question form, brackets, or an option that does not read standalone)",
    variety: "two questions used the SAME set of three options — every question needs its own distinct options",
    grounding: "a question's words were mostly not found in the lesson context — use the lesson's exact words",
    answerability: "no option genuinely answered its question, or the marked answer was not the best-supported option",
  };
  // Name the offending question so the retry fixes that item instead of
  // repeating its hallucinated fact ("The troposphere is thickest at the
  // poles" failed twice when the retry got no specifics).
  const firstFailingQuestion = (qs: unknown, gate: string): string => {
    if (!Array.isArray(qs)) return "";
    for (const entry of qs) {
      const e = entry as { options?: unknown; answer?: unknown; question?: unknown };
      const question = typeof e?.question === "string" ? e.question : "";
      if (!question) continue;
      if (gate === "answerability") {
        const options = Array.isArray(e.options)
          ? e.options.filter((opt): opt is string => typeof opt === "string")
          : [];
        const answer = typeof e.answer === "string" ? e.answer : String(e.answer ?? "");
        if (!isAnswerableQuizQuestion(question, options, answer, groundingSource)) return question;
      } else if (gate === "grounding") {
        if (!quizGroundedInContext([entry], groundingSource)) return question;
      }
    }
    return "";
  };

  let failedGate = gateFailure(parsed);
  if (failedGate) {
    console.log(`[quiz] first response failed (${failedGate}), retrying with a stricter prompt`);
    const failingQ = firstFailingQuestion(parsed, failedGate);
    let retryReason = failingQ
      ? `${GATE_REASONS[failedGate]}. Failing question: "${failingQ.slice(0, 160)}" — replace it with a question whose answer appears word-for-word in the lesson.`
      : GATE_REASONS[failedGate];
    if ((failedGate === "answerability" || failedGate === "grounding") && failingQ) {
      const actual = answerCandidateSentences(failingQ, groundingSource)[0];
      if (actual) {
        retryReason += failedGate === "grounding"
          ? ` The lesson's own sentence for this topic: "${actual.slice(0, 200)}" — rebuild the question from these exact words instead of paraphrasing them.`
          : ` The lesson's own sentence for this topic: "${actual.slice(0, 200)}" — make the correct option repeat these exact words.`;
      }
    }
    const retryPrompt = buildQuizRetryPrompt(quiz, groundingSource, topic, age, numQuestions, retryReason);
    const retryResponse = await generateAnswer(retryPrompt, tokenBudget);
    const retryCleaned = cleanRawQuiz(retryResponse);
    parsed = safeParseQuiz(retryCleaned);
    const retryDedupe = dedupeOptionSetDuplicates(parsed);
    parsed = retryDedupe.quiz;
    dedupedShort = retryDedupe.dropped === 1;
    failedGate = gateFailure(parsed);
    if (failedGate) {
      console.error(`[quiz] retry failed (${failedGate})`, retryCleaned);
      parsed = defaultQuizForTopic(topic, numQuestions, groundingSource, age);
    }
  }

  // The answerability/grounding/variety gates above already validated the
  // model's own stem↔option pairing, so reordering options now can only
  // break a quiz that passed — observed: the swap-fixer exchanged two
  // correct option sets on a passing quiz (support-neutral by its coarse
  // metric) and the final gate then rejected the damage. Only normalize
  // the answer against its own option list (applies to fallback quizzes
  // too — their pairs are correct by construction).
  if (parsed) {
    parsed = fixQuizAnswers(parsed);
  }

  if (!parsed || !validateQuizFormat(parsed, dedupedShort ? numQuestions - 1 : numQuestions) || !hasQuizVariety(parsed) || !quizGroundedInContext(parsed, groundingSource) || !quizAnswerableInContext(parsed, groundingSource) || !(parsed as unknown[]).every(isValidQuizQuestion)) {
    console.error("[quiz] Invalid quiz format / not grounded / unanswerable after fixes:", JSON.stringify(parsed));
    parsed = defaultQuizForTopic(topic, numQuestions, groundingSource, age);
  }

  const totalTime = Date.now() - startTime;
  console.log(`[quiz] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
  return NextResponse.json({ quiz: JSON.stringify(parsed), _timing: { totalTime, retrievalTime, llmTime } });
}