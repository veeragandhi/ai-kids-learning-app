import { contentTokens } from "./retrieval";

// lib/concepts.ts — deterministic concept identification + coverage for lessons.
//
// The lesson flow is: source material -> important learning concepts ->
// child-level lesson -> coverage validation -> display. Concept handling is
// deterministic (no LLM) so it is testable and never invents facts.

const INSTRUCTION_LINE =
  /^(?:[A-Za-z]\s*[.)]\s*)?(?:tick|match|circle|write|choose|fill|draw|colour|color|look at|read the|answer the|true or false|name|date)\b/i;
const KEY_LINE =
  /^(?:answer|ans|key|solution|marking|teacher|objective|marks?|score|total|page\s*\d+|name\s*:|date\s*:)\b/i;
const OPTION_LINE = /^\s*[A-Ea-e]\s*[.)]\s+\S/;
const VAGUE_CONCEPT = new Set([
  "thing", "things", "stuff", "way", "ways", "part", "parts", "kind",
  "sort", "type", "lot", "lots", "bit", "well", "also", "very", "just",
  "really", "much", "many", "several", "different", "own", "help", "helps",
]);

function splitSentences(text: string): string[] {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[.#*\s]+/, "").trim())
    .filter((s) => s.length >= 12 && s.length <= 280 && /[A-Za-z]{3,}/.test(s));
}

function isLearningSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!s || INSTRUCTION_LINE.test(s) || KEY_LINE.test(s)) return false;
  if (OPTION_LINE.test(s) && s.split(/\s+/).length <= 8) return false;
  // Checkbox / blank scaffolding that survived normalization.
  if (/\[ \]|\[BLANK\]/i.test(s)) return false;
  return true;
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const other = new Set(b);
  const hits = a.filter((token) => other.has(token)).length;
  return hits / Math.max(a.length, b.length);
}

// Identify the important educational concepts/facts in teaching text.
// Returns short phrases (never invented: always trimmed source sentences).
export function extractImportantConcepts(
  teachingText: string,
  topic: string,
  maxConcepts = 8,
): string[] {
  const topicTokens = contentTokens(topic);
  const candidates = splitSentences(teachingText)
    .filter(isLearningSentence)
    .map((sentence) => {
      const tokens = contentTokens(sentence).filter((t) => !VAGUE_CONCEPT.has(t));
      const topicHits = tokens.filter((t) => topicTokens.includes(t)).length;
      // High weight on topic hits, but also baseline for informative sentences.
      // If a sentence has NO topic hits, it's only included if it's very informative
      // AND we don't have enough topic-specific concepts yet.
      const score = topicHits * 10 + Math.min(tokens.length, 10);
      return { sentence, tokens, topicHits, score };
    })
    .filter((c) => c.tokens.length >= 5 && (c.topicHits > 0 || c.score > 8))
    .sort((a, b) => b.score - a.score);

  const concepts: string[] = [];
  const accepted: string[][] = [];
  
  // First pass: Only take sentences that actually mention the topic
  for (const candidate of candidates) {
    if (concepts.length >= maxConcepts) break;
    if (candidate.topicHits === 0) continue; 
    if (accepted.some((tokens) => tokenOverlap(candidate.tokens, tokens) >= 0.6)) continue;
    accepted.push(candidate.tokens);
    const words = candidate.sentence.replace(/[.!?]+$/, "").split(/\s+/);
    concepts.push(words.slice(0, 16).join(" "));
  }

  // Topic Guard: If we found very little about the actual topic (e.g., only 1 mention),
  // do NOT proceed with adding supporting facts. This prevents a "Weather" text
  // from being forced into a "Plants" lesson just because the word plants appeared once.
  if (concepts.length < 2) {
    console.log(`[concepts] only ${concepts.length} topic hits found - too low for a quality lesson`);
    return [];
  }

  // Second pass: Now that we have a solid base (at least 2 facts), allow some 
  // "supporting" facts to round out the lesson.
  if (concepts.length < 5) {
    for (const candidate of candidates) {
      if (concepts.length >= Math.min(4, maxConcepts)) break;
      if (candidate.topicHits > 0) continue; // Already handled
      // Skip narrative filler like "You reach up and shiver"
      if (/^(you|i|we|they)\b.*\b(shiver|reach|signals|listen)\b/i.test(candidate.sentence)) continue;
      
      if (accepted.some((tokens) => tokenOverlap(candidate.tokens, tokens) >= 0.5)) continue;
      accepted.push(candidate.tokens);
      const words = candidate.sentence.replace(/[.!?]+$/, "").split(/\s+/);
      concepts.push(words.slice(0, 16).join(" "));
    }
  }
  return concepts;
}

export type ConceptCoverage = {
  total: number;
  covered: number;
  missing: string[];
};

// Validate whether each important concept is represented in the lesson.
// Matching is token-overlap based, so simpler child-friendly wording counts.
export function conceptCoverage(lesson: string, concepts: string[]): ConceptCoverage {
  const lessonTokens = new Set(contentTokens(lesson));
  const missing: string[] = [];
  let covered = 0;
  for (const concept of concepts) {
    const tokens = contentTokens(concept).filter((t) => !VAGUE_CONCEPT.has(t));
    if (tokens.length === 0) {
      covered += 1;
      continue;
    }
    const hits = tokens.filter((t) => lessonTokens.has(t)).length;
    const ratio = hits / tokens.length;
    if (hits >= Math.max(1, Math.ceil(tokens.length * 0.5)) && ratio >= 0.4) {
      covered += 1;
    } else {
      missing.push(concept);
    }
  }
  return { total: concepts.length, covered, missing };
}
