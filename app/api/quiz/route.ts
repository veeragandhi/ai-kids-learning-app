import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";
import { OCR_MARKER_GUARD, toTeachingText } from "@/lib/ocr";
import { defaultQuizForTopic } from "@/lib/quiz-fallback";

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
  const oTokens = new Set(
    options.flatMap((option) => quizContentWords(option))
  );
  const contextTokens = new Set(quizContentWords(context));
  if (contextTokens.size === 0) return 0;

  const allTopicTokens = new Set<string>([...qTokens, ...aTokens, ...oTokens]);
  const hits = [...allTopicTokens].filter((token) => contextTokens.has(token)).length;
  return hits / Math.max(1, allTopicTokens.size);
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
    return quizGroundingScore(question, options, answer, context) >= 0.35;
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

function isAnswerableQuizQuestion(
  question: string,
  options: string[],
  answer: string,
  context: string
): boolean {
  if (!context || options.length !== 3) return false;
  // NOTE: top-1 only, deliberately strict. The single sentence closest to
  // the stem is the question's answer sentence — if no option matches IT,
  // the options belong to a different question (Q5-type), even when a
  // second-best sentence elsewhere mentions one of the options.
  const top = topSentencesForQuestion(String(question || ""), context, 1);
  if (top.length === 0) return false;
  const supports = options.map((opt) => optionSupport(opt, top));
  const maxSupport = Math.max(...supports);
  // (a) Q1-type: no option answers the stem — the correct fact is missing.
  if (maxSupport < 0.3) {
    console.error(
      `[quiz] Unanswerable: no option matches the question's answer sentence (best ${maxSupport.toFixed(2)}): ${String(question).slice(0, 80)}`
    );
    return false;
  }
  // (b) The marked answer must BE a best-matching option, not a distractor.
  const answerSupport = optionSupport(String(answer || ""), top);
  if (answerSupport + 0.05 < maxSupport) {
    console.error(
      `[quiz] Unanswerable: answer "${String(answer).slice(0, 40)}" (support ${answerSupport.toFixed(2)}) is not the best-supported option (${maxSupport.toFixed(2)})`
    );
    return false;
  }
  // (c) Q5-type guard: options must discriminate — if every option matches
  // the sentence equally there is no single correct answer.
  const minSupport = Math.min(...supports);
  if (maxSupport > 0.5 && maxSupport - minSupport < 0.1) {
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

function isFragmentOption(opt: string): boolean {
  const t = String(opt || "").trim();
  if (!t) return true;
  if (/^[a-z]/.test(t)) return true;
  if (BARE_VERB_START.test(t) && !/^(it|they|he|she|we|the|a|plants?|roots?|seeds?|leaves?)\b/i.test(t)) return true;
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

function fixSwappedQuizOptions(quiz: any, context = ""): any {
  if (!Array.isArray(quiz) || quiz.length < 2) return quiz;
  const fixed = quiz.map((q: any) => ({ ...q }));
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
      const currentFrag = oi.filter(isFragmentOption).length + oj.filter(isFragmentOption).length;
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
      // swapped fragment sets are fixed.
      if (swappedEcho + 0.15 < currentEcho || swappedGround > currentGround + 0.2 || crossBetter || swappedSupport > currentSupport + 0.3) {
        // Never swap into a worse fragment situation.
        const fragAfterSwap = oj.filter(isFragmentOption).length + oi.filter(isFragmentOption).length;
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

function fixQuizAnswers(quiz: any): any {
  // Try to fix answers that are close to options (typos)
  return quiz.map((q: any) => {
    const { answer, options } = q;
    const normalizedOptions = Array.isArray(options) ? options.filter((opt) => typeof opt === "string") : [];
    let normalizedAnswer = "";

    if (typeof answer === "string") {
      normalizedAnswer = answer;
    } else if (Array.isArray(answer) && answer.length > 0) {
      normalizedAnswer = String(answer[0]);
    } else if (answer != null) {
      normalizedAnswer = String(answer);
    }

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
function fixQuizAnswerability(quiz: any, context = ""): any {
  if (!Array.isArray(quiz) || !context) return quiz;
  return quiz.map((q: any) => {
    const question = String(q?.question || "");
    const options = Array.isArray(q?.options) ? q.options : [];
    const answer = typeof q?.answer === "string" ? q.answer : String(q?.answer ?? "");
    if (!question || options.length !== 3) return q;
    if (isAnswerableQuizQuestion(question, options, answer, context)) return q;
    if (questionBestSupport(question, options, context) < 0.3) return q;
    return { ...q, answer: pickAnswerForQuestion(question, options, context) };
  });
}

function validateQuizFormat(quiz: any, expectedCount?: number): boolean {
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
  
  return quiz.every((q, idx) => {
    // Check required fields exist
    if (!q.question) {
      console.error(`[quiz] Question ${idx}: missing 'question' field`);
      return false;
    }
    if (!q.options) {
      console.error(`[quiz] Question ${idx}: missing 'options' field`);
      return false;
    }
    if (!q.answer) {
      console.error(`[quiz] Question ${idx}: missing 'answer' field`);
      return false;
    }
    
    // Check types
    if (typeof q.question !== "string") {
      console.error(`[quiz] Question ${idx}: 'question' is not a string`);
      return false;
    }
    if (!Array.isArray(q.options)) {
      console.error(`[quiz] Question ${idx}: 'options' is not an array`);
      return false;
    }
    if (typeof q.answer !== "string") {
      console.error(`[quiz] Question ${idx}: 'answer' is not a string`);
      return false;
    }
    
    // Check options are all strings
    if (!q.options.every((opt: any) => typeof opt === "string")) {
      console.error(`[quiz] Question ${idx}: not all options are strings`);
      return false;
    }
    
    // Check exactly 3 options
    if (q.options.length !== 3) {
      console.error(`[quiz] Question ${idx}: has ${q.options.length} options, need exactly 3`);
      return false;
    }
    
    // Check for duplicate options
    const uniqueOptions = new Set(q.options.map((opt: string) => opt.trim().toLowerCase()));
    if (uniqueOptions.size !== 3) {
      console.error(`[quiz] Question ${idx}: has duplicate options [${q.options.map((o: string) => `"${o}"`).join(", ")}]`);
      return false;
    }
    
    // Check answer is in options
    if (!q.options.includes(q.answer)) {
      console.error(`[quiz] Question ${idx}: answer "${q.answer}" not in options [${q.options.map((o: string) => `"${o}"`).join(", ")}]`);
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

function hasQuizVariety(quiz: any): boolean {
  if (!Array.isArray(quiz) || quiz.length < 2) return true;

  const normalizedQuestions = quiz.map((item) =>
    String(item?.question || "")
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
    const question = String(item?.question || "").trim();
    return /\bwhy is\b.*\b(?:helps|uses|has|have|does|are)\b/i.test(question)
      || /\bhow does\b.*\b(?:is|are|was|were|has|have)\b/i.test(question);
  })) {
    console.error("[quiz] Rejected grammatically malformed question stem");
    return false;
  }

  const optionSets = quiz.map((item) =>
    Array.isArray(item?.options)
      ? item.options.map((option: unknown) => String(option).toLowerCase().trim()).sort().join("|")
      : ""
  );
  if (new Set(optionSets).size !== optionSets.length) {
    console.error("[quiz] Rejected repeated option sets");
    return false;
  }

  const questionWords = quiz.map((item) => new Set(quizContentWords(item.question)));
  for (let i = 0; i < questionWords.length; i++) {
    for (let j = i + 1; j < questionWords.length; j++) {
      const shared = [...questionWords[i]].filter((word) => questionWords[j].has(word));
      const smaller = Math.min(questionWords[i].size, questionWords[j].size);
      if (smaller > 0 && shared.length / smaller >= 0.8) {
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

function parseQuizObject(objText: string) {
  const questionMatch = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(objText);
  const optionsMatch = /"options"\s*:\s*\[([^\]]*)\]/i.exec(objText);
  const answerMatch = /"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(objText);

  const question = questionMatch?.[1].replace(/\\"/g, '"');
  const options = optionsMatch ? extractQuotedStrings(optionsMatch[1]) : [];
  let answer = answerMatch?.[1].replace(/\\"/g, '"');

  if (!answer) {
    const afterOptions = optionsMatch ? objText.slice(optionsMatch.index + optionsMatch[0].length) : objText;
    const strayMatch = /"((?:[^"\\]|\\.)*)"/.exec(afterOptions);
    if (strayMatch) {
      const stray = strayMatch[1].replace(/\\"/g, '"');
      if (stray.toLowerCase() !== "answer" && stray.toLowerCase() !== "reason") {
        answer = stray;
      }
    }
  }

  if (!question || options.length === 0) {
    return null;
  }

  const normalizedOptions = options.slice(0, 3);

  return {
    question,
    options: normalizedOptions,
    answer: answer ?? normalizedOptions[0],
  };
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

  const objects: any[] = [];

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

function safeParseQuiz(cleanedQuiz: string) {
  try {
    const parsed = JSON.parse(cleanedQuiz);
    // Validate all questions
    if (Array.isArray(parsed) && parsed.every(isValidQuizQuestion)) {
      return parsed;
    }
    console.error("[quiz] Parsed JSON but questions failed validation");
  } catch (error) {
    console.error("[quiz] JSON parse failed:", error);
  }

  const repaired = repairQuizJson(cleanedQuiz);
  const arrayText = extractFirstJsonArray(repaired) || extractFirstJsonArray(cleanedQuiz);

  if (arrayText) {
    try {
      const parsed = JSON.parse(arrayText);
      if (Array.isArray(parsed) && parsed.every(isValidQuizQuestion)) {
        return parsed;
      }
      console.error("[quiz] extractFirstJsonArray parse succeeded but validation failed");
    } catch (arrayError) {
      console.error("[quiz] extractFirstJsonArray parse failed:", arrayError, "arrayText:", arrayText);
    }
  }

  try {
    const parsed = JSON.parse(repaired);
    if (Array.isArray(parsed) && parsed.every(isValidQuizQuestion)) {
      return parsed;
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

function buildQuizRetryPrompt(raw: string, context: string, topic: string, age: number, numQuestions: number = 3) {
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

  return `The previous response was invalid or had bad questions. Fix these issues:

⚠️ CRITICAL RULES - FOLLOW STRICTLY:

1. LANGUAGE: Write ONLY in ENGLISH. Do NOT mix languages.
   ✗ DON'T: "¿Qué tipo..." (Spanish)
   ✓ DO: "What type..." (English only)

2. CONTENT SOURCE: Use ONLY information from the provided CONTEXT below.
   ✗ DON'T: Add facts from outside knowledge
   ✗ DON'T: Hallucinate information
   ✗ DON'T: Ask about a sub-topic the CONTEXT does NOT mention
   ✓ DO: Base every question AND every option on the CONTEXT provided

3. QUESTIONS MUST BE QUESTIONS, NOT STATEMENTS:
   ✗ BAD: "A family makes a home" (statement)
   ✓ GOOD: "What does a family make?" (question)
   Questions MUST have a "?" and start with: What, Which, How, Who, Why, When, Where

4. NO BRACKETS IN OPTIONS:
   ✗ BAD: "(Small family)" or "[Small family]"
   ✓ GOOD: "Small family"

  5. EACH QUESTION MUST BE SPECIFIC about what it asks
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

function isValidQuizQuestion(question: any): boolean {
  if (!question || typeof question !== "object") return false;
  if (typeof question.question !== "string" || !question.question.trim()) return false;
  if (!Array.isArray(question.options) || question.options.length !== 3) return false;
  if (typeof question.answer !== "string" || !question.answer.trim()) return false;

  // Check that question is actually a question, not a statement
  const questionText = question.question.trim();
  const questionStarters = ["What", "Which", "How", "Who", "Why", "When", "Where", "Can", "Do", "Does", "Is", "Are"];
  const startsWithQuestion = questionStarters.some(starter => 
    questionText.toLowerCase().startsWith(starter.toLowerCase())
  );
  if (!startsWithQuestion || !questionText.includes("?")) {
    console.error("[quiz] Invalid: not a proper question:", questionText);
    return false;
  }

  // Check that all options are strings and have no brackets
  if (!question.options.every((opt: any) => typeof opt === "string" && opt.trim())) return false;
  
  // Check for brackets in options
  for (const opt of question.options) {
    if (/[\(\)\[\]\{\}]/.test(opt)) {
      console.error("[quiz] Invalid: option contains brackets:", opt);
      return false;
    }
  }

  // Reject fragment options that cannot stand alone
  // (reported bug: "Make the leaves bigger", "Travel from the roots").
  for (const opt of question.options) {
    if (isFragmentOption(String(opt))) {
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
  const uniqueOptions = new Set(question.options.map((opt: string) => opt.trim().toLowerCase()));
  if (uniqueOptions.size !== 3) {
    console.error("[quiz] Invalid: duplicate options detected");
    return false;
  }

  // Check that answer is one of the options
  const answerTrimmed = question.answer.trim();
  const hasAnswer = question.options.some(
    (opt: string) => opt.trim().toLowerCase() === answerTrimmed.toLowerCase()
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

3. Questions must avoid options that are ALL true. UNLESS you use "All of the above" (still exactly 3 options total):
   BAD: "What does a family usually consist of?" + options: [Single parent, Couple with children, Just parents] - confusing!
   GOOD: "What can a family have?" + options: [Mom and Dad with kids, Grandparents, All of the above] - clear that all are valid!

4. When to use "All of the above" (always exactly 3 options total):
   ✓ USE: "What can a family include?" + options: [Parents with children, Grandparents, All of the above]
   ✓ USE: "Which are members of a family?" + options: [Mom with Dad and Kids, Grandparents, All of the above]
   ✗ DON'T USE: For questions about categories/types where only ONE is correct
   ✗ DON'T USE: For definitional questions

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
    with a subject (The seed ..., The roots ..., Elephants ...). Never start
    an option with a bare verb (Make ..., Travel ..., Stay ...).
    Prefer the CONTEXT's own simple words. Keep each option to 2-6 words.
    Do not reuse the exact same three options for multiple questions.

6. Each question must have EXACTLY 3 options (can include "All of the above" as one option).
7. EXACTLY ONE option is correct.
8. The answer MUST exactly match one of the 3 options exactly.

The question value must be a string.
The options value must be an array of exactly 3 strings.
The answer value must be a single string exactly matching one of the options.

IMPORTANT: Use DOUBLE QUOTES (") for ALL string values, NEVER use single quotes (').

EXAMPLES OF EXCELLENT QUESTIONS (age-appropriate and unambiguous):

For a 6-year-old about families:
Example WITHOUT "All of the above" (definitional questions):
[{"question":"What usually makes a family?","options":["Mom and Dad with kids","Just toys","Just a house"],"answer":"Mom and Dad with kids"},{"question":"How many kids are in a small family?","options":["One or two children","Five or more children","No children"],"answer":"One or two children"}]

Example WITH "All of the above" (membership/inclusion questions, still exactly 3 options):
[{"question":"What can a family have?","options":["Mom and Dad with kids","Grandparents and Aunts","All of the above"],"answer":"All of the above"}]

For a 9-year-old about families:
Example WITHOUT "All of the above" (category questions):
[{"question":"Which family type has only parents and one or two children?","options":["Small family","Large family","Single parent household"],"answer":"Small family"}]

Example WITH "All of the above" (membership questions, still exactly 3 options):
[{"question":"Which of these can be family members?","options":["Parents and Siblings","Grandparents","All of the above"],"answer":"All of the above"}]

Notice:
- When using "All of the above": Question asks WHAT CAN or WHICH...CAN (membership/inclusion)
- When NOT using: Question asks WHAT IS or HOW MANY (categories/definitions)
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
  // Clamp to the same 1-10 range the UI allows so "4" is always respected.
  const parsedCount = parseInt(String(rawNumQuestions), 10);
  const numQuestions = Number.isFinite(parsedCount)
    ? Math.max(1, Math.min(10, parsedCount))
    : 3;

  const retrievalStart = Date.now();
  // Fetch extra chunks for quiz so small lessons still yield enough distinct facts.
  // Teach from prose: the worksheet's own questions otherwise get copied verbatim
  // as quiz "questions" that are really statements ("A large family has ...").
  const context = toTeachingText(await getRelevantContext(topic, 5, 0.30));
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
  let fromFallback = false;

  if (!parsed || !hasQuizVariety(parsed) || !quizGroundedInContext(parsed, groundingSource) || !quizAnswerableInContext(parsed, groundingSource)) {
    console.log("[quiz] first response failed parse / variety / grounding / answerability, retrying with a stricter prompt");
    const retryPrompt = buildQuizRetryPrompt(quiz, groundingSource, topic, age, numQuestions);
    const retryResponse = await generateAnswer(retryPrompt, tokenBudget);
    const retryCleaned = cleanRawQuiz(retryResponse);
    parsed = safeParseQuiz(retryCleaned);
    if (!parsed || !hasQuizVariety(parsed) || !quizGroundedInContext(parsed, groundingSource) || !quizAnswerableInContext(parsed, groundingSource)) {
      console.error("[quiz] retry parse / grounding / answerability also failed", retryCleaned);
      parsed = defaultQuizForTopic(topic, numQuestions, groundingSource, age);
      fromFallback = true;
    }
  }

  // The deterministic fallback builds each option set matched to its own
  // stem by construction — running the swap-fixer over it can only mismatch
  // answers across questions (the reported "Q1's answer under Q2" bug).
  parsed = fromFallback
    ? fixQuizAnswers(parsed)
    : fixQuizAnswerability(
        fixQuizAnswers(fixSwappedQuizOptions(parsed, groundingSource)),
        groundingSource
      );

  if (!parsed || !validateQuizFormat(parsed, numQuestions) || !hasQuizVariety(parsed) || !quizGroundedInContext(parsed, groundingSource) || !quizAnswerableInContext(parsed, groundingSource) || !(parsed as unknown[]).every(isValidQuizQuestion)) {
    console.error("[quiz] Invalid quiz format / not grounded / unanswerable after fixes:", JSON.stringify(parsed));
    parsed = defaultQuizForTopic(topic, numQuestions, groundingSource, age);
  }

  const totalTime = Date.now() - startTime;
  console.log(`[quiz] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
  return NextResponse.json({ quiz: JSON.stringify(parsed), _timing: { totalTime, retrievalTime, llmTime } });
}