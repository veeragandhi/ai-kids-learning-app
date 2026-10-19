// lib/lessonText.ts — deterministic post-processing for generated lessons.
//
// The small model repeats itself, copies worksheet scaffolding, and narrates
// meta labels ("Title:"). These helpers strip all of that AFTER generation so
// the child only sees plain, age-appropriate teaching paragraphs. Kept free of
// imports so the cleaning rules can be unit-checked without the Next runtime.

// Strip worksheet section scaffolding the small model copies from the source
// ("Thinking About It:", "✨ Amazing Fact: ... ✨"). Standalone labels are
// dropped; inline labels are unwrapped so the taught fact survives as a
// plain paragraph.
function stripWorksheetSection(line: string): string {
  if (!line) return line;
  if (/^\W*(thinking about it|think about it|amazing fact|fun fact|did you know|discover|key words?)\W*$/i.test(line)) {
    return "";
  }
  return line
    .replace(/[✨⭐🌟💡📌🤔]/gu, "")
    .replace(/^\s*(amazing fact|fun fact|did you know)\s*:\s*/i, "")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
}

// Strip meta labels the small model narrates about its own output
// ("Title:", "A short title:", "Read carefully:", "Introduction:").
function stripMetaPrefix(line: string): string {
  if (!line) return line;
  return line
    .replace(/^\s*(?:a\s+short\s+title|short\s+title|title|topic|read\s+carefully|introduction|intro|note)\s*:\s+/i, "")
    .trim();
}

// Strip leading list prefixes that the small model sometimes emits ("1.", "2)",
// "- ", "* ", "• ", "Line 1:"). Keep the line content.
function stripLinePrefix(line: string): string {
  if (!line) return line;
  // Apply repeatedly: the model stacks prefixes ("1. Line 2:", "- 3. text").
  let stripped = line;
  for (let i = 0; i < 3; i++) {
    const next = stripped
      // "Line 1:", "line 2 -", "Step 1:" style prefixes kids reported seeing.
      .replace(/^\s*(?:line|step|point|para(?:graph)?)\s*\d{1,3}\s*[:.)\-–—]?\s+/i, "")
      // "1. " or "1) " — must be followed by a letter so we don't strip years.
      .replace(/^\s*\d{1,3}\s*[.)]\s+(?=[A-Za-z])/, "")
      // "- " / "* " / "• " bullets
      .replace(/^\s*[-*•]\s+(?=[A-Za-z])/, "");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped.trim();
}

// Make sure each non-empty body line ends with punctuation. The small model
// often forgets the final period, which hurts grammar and read-aloud rhythm.
function ensureSentencePunctuation(line: string): string {
  if (!line) return line;
  if (/[.!?:"")]$/.test(line)) return line;
  return `${line}.`;
}

function sentenceTokens(sentence: string): string[] {
  return sentence.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// True when `sentence` repeats a sentence already taught (`seen`). Exact
// repeats and near-repeats both count — models restate the same fact with a
// slightly different tail ("...and more" vs "...and so on"). Overlap is
// measured on DISTINCT tokens with a length-ratio guard so a short sentence
// that happens to sit inside a longer, different one is never dropped.
// Sentences under three words are never touched.
function isDuplicateSentence(sentence: string, seen: string[][]): boolean {
  const tokens = sentenceTokens(sentence);
  if (tokens.length < 3) return false;
  const distinct = [...new Set(tokens)];
  for (const prev of seen) {
    const curSet = new Set(distinct);
    let shared = 0;
    for (const token of prev) {
      if (curSet.has(token)) shared++;
    }
    const min = Math.min(prev.length, distinct.length);
    const max = Math.max(prev.length, distinct.length);
    if (shared === prev.length && shared === distinct.length) return true;
    if (shared >= 5 && shared / min >= 0.8 && max / min <= 1.5) return true;
  }
  seen.push(distinct);
  return false;
}

// Drop repeated sentences across the whole lesson (models loop on the same
// fact) while keeping every unique sentence — a long lesson loses only its
// repetition, never information. Lines emptied by dedupe are removed.
function dedupeSentences(lines: string[]): string[] {
  const seen: string[][] = [];
  const out: string[] = [];
  for (const line of lines) {
    if (!line) {
      out.push("");
      continue;
    }
    const parts = line.split(/(?<=[.!?])\s+/).filter((part) => part.trim());
    const kept: string[] = [];
    for (const part of parts) {
      if (!isDuplicateSentence(part, seen)) kept.push(part);
    }
    if (kept.length > 0) out.push(kept.join(" "));
  }
  return out;
}

// Safety net for the small model: strip markup and any worksheet scaffolding
// that leaked past the prompt rules, then remove repeated sentences.
export function cleanLessonText(raw: string): string {
  const out = (raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*LESSON\s*:\s*/i, "")
    .replace(/^\s*Lesson\s*:\s*/i, "");
  const lines = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .map((line) => stripMetaPrefix(line))
    .map((line) => stripWorksheetSection(line))
    .map((line) => {
      // Deep clean "Book Talk" that prompt rules might miss
      return line
        .replace(/\b(?:as shown in|in the|this|the)\s+(?:picture|image|transcription|text|diagram|table|chart)\b/gi, "")
        // Embedded meta clause: strip it together with its bracketing commas
        // so "phenomena, which we will explore in this chapter, take place"
        // becomes "phenomena take place", not "phenomena, take place".
        .replace(/,\s*(?:which|that)\s+we\s+will\s+explore\s+in\s+this\s+chapter\s*,?/gi, " ")
        .replace(/\b(?:which|that)\s+we\s+will\s+explore\s+in\s+this\s+chapter\s*,?/gi, "")
        .replace(/,\s*(?:in|throughout)\s+this\s+chapter\s*,?/gi, " ")
        .replace(/\b(?:in|throughout)\s+this\s+chapter\s*,?/gi, "")
        .replace(/\bin\s+your\s+Science\s+classes\b/gi, "")
        // Safety net: never leave a doubled comma behind a phrase strip.
        .replace(/,\s*(?:,\s*)+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/\(\s*\)/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    })
    .filter((line) => {
      if (!line) return true;
      // Worksheet scaffolding: numbered option lines like "1. (a / b)".
      if (/^\d+\s*[.)]\s/.test(line) && /\([^()\n]{1,60}\/[^()\n]{1,60}\)/.test(line)) {
        return false;
      }
      if (/^\d{1,3}$/.test(line)) return false;
      // A lesson never asks the child questions (that is the Ask flow's
      // job): drop "Could it reach something far away?"-style lines
      // wherever they appear, not just at the tail.
      if (line.includes("?")) return false;
      return true;
    })
    .map((line) => stripLinePrefix(line))
    .filter((line, index, arr) => {
      // Drop a line that became empty after stripping, but keep paragraph breaks.
      if (line) return true;
      // Keep at most one blank line in a row.
      return index === 0 || arr[index - 1] !== "";
    });
  const withPunctuation = lines.map((line, index) =>
    index === 0 ? line : ensureSentencePunctuation(line),
  );
  const joined = dedupeSentences(withPunctuation)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // A lesson must not ask questions (that is the Ask flow's job). Drop trailing
  // question chatter such as "Would you like to learn more?" from the end only,
  // and never shorten the lesson below teaching size.
  const withoutTail = joined.replace(/(?:\n+[^\n?]*\?)+\s*$/, "").trim();
  if (withoutTail && withoutTail.split(/\s+/).length >= 20) {
    return withoutTail;
  }
  return joined;
}

function wordRun(sentence: string): string[] {
  return sentence.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Longest run of identical words in sequence (a, b compared as word arrays).
function longestCommonWordRun(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  let max = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > max) max = cur[j];
      }
    }
    prev = cur;
  }
  return max;
}

// Sentences the model copied from the context instead of rephrasing. A
// sentence qualifies when it shares a run of MIN_COPY_WORDS consecutive words
// with the context — the prompt forbids copying more than 5 words in a row,
// so 8 gives one word of tolerance for unavoidable technical phrasing.
const MIN_COPY_WORDS = 8;

export function findCopiedSentences(lesson: string, context: string): string[] {
  const contextWords = wordRun(context);
  if (contextWords.length < MIN_COPY_WORDS) return [];
  const copied: string[] = [];
  for (const sentence of (lesson || "").split(/(?<=[.!?])\s+/)) {
    const words = wordRun(sentence);
    if (words.length < MIN_COPY_WORDS) continue;
    if (longestCommonWordRun(words, contextWords) >= MIN_COPY_WORDS) {
      copied.push(sentence.trim());
    }
  }
  return copied;
}
