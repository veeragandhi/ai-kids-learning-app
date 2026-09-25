// Deterministic last-resort quiz builder (no LLM). Used when the model
// returns unusable JSON — for a 6-year-old this IS the quiz she sees, so it
// must still be grammatical, clean, and matched:
// - stems use one lowercase focus word ("about elephants"), never the first
//   four raw words ("Elephants largest land animals");
// - options are plain cleaned sentences with no markdown ("* ...", "to: *");
// - each option set belongs to its own stem by construction;
// - options are short enough for little kids to read.

export type FallbackQuizQuestion = {
  question: string;
  options: string[];
  answer: string;
};

// Words that read broken after "about" ("about live", "about very") and can
// never be a question focus.
const FALLBACK_FOCUS_SKIP = new Set([
  "they", "them", "their", "it", "its", "this", "that", "these", "those",
  "there", "here", "he", "she", "we", "you", "his", "her", "our", "your",
  "live", "lives", "living", "use", "uses", "used", "using", "have", "has",
  "had", "having", "make", "makes", "made", "making", "take", "takes",
  "took", "taken", "get", "gets", "got", "give", "gives", "gave", "go",
  "goes", "went", "come", "comes", "came", "move", "moves", "moved",
  "moving", "drink", "drinks", "eat", "eats", "sleep", "sleeps", "fly",
  "swim", "run", "walk", "breathe", "breathes", "smell", "smells", "touch",
  "touches", "pick", "picks", "find", "finds", "found", "call", "calls",
  "called", "very", "just", "also", "more", "most", "many", "much", "like",
  "well", "different", "same", "other", "another", "such", "own", "often",
  "usually", "carefully", "quickly", "slowly", "big", "small", "long",
  "short", "large", "little", "can", "could", "will", "would", "should",
  "does", "with", "from", "what", "when", "where", "which", "how", "why",
  "who", "lesson", "described", "says", "communicate", "communicates",
  "largest", "smallest", "longest", "shortest", "biggest", "tallest",
  "fastest", "slowest", "land", "lands",
]);

// Plain-sentence cleanup for lesson text with worksheet markdown:
// "* Pick up food..." -> "Pick up food...", "trunks to: * Smell" ->
// "trunks to smell". First letter is capitalized so options never trip the
// lowercase-fragment check.
export function cleanFallbackSentence(sentence: string): string {
  let out = String(sentence || "")
    .replace(/\*\*/g, "")
    .replace(/^[#>\s]+/, "")
    .replace(/^\s*(?:[-•*]|\d+[.)])\s+/, "")
    .replace(/\*/g, "")
    .replace(/\bto\s*:\s*([A-Za-z])/g, (_m, c: string) => ` to ${String(c).toLowerCase()}`)
    .replace(/\s{2,}/g, " ")
    .trim()
    // Leading emoji / symbols ("🤔 Think About It...") are worksheet
    // decoration, never option text.
    .replace(/^[^A-Za-z0-9"']+/, "");
  out = out.replace(/\s+([.,!?;:])/g, "$1");
  if (out) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
    if (!/[.!?]$/.test(out)) out += ".";
  }
  return out;
}

// One lowercase focus word for the stem: first content word, completing a
// possessive ("elephant's" -> "elephant's trunk"). Never reused within one
// quiz so stems stay distinct.
export function fallbackFocus(sentence: string, topic: string, used: Set<string>): string {
  const words = sentence
    .replace(/[.?!,;:()[\]{}"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  for (let k = 0; k < words.length; k++) {
    const lower = words[k].toLowerCase();
    if (FALLBACK_FOCUS_SKIP.has(lower)) continue;
    let focus = lower;
    if ((lower.endsWith("'s") || lower.endsWith("s'")) && words[k + 1]) {
      focus = `${lower} ${words[k + 1].toLowerCase()}`;
    }
    if (used.has(focus)) continue;
    return focus;
  }
  const t = topic.trim().toLowerCase();
  if (t && !used.has(t)) return t;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (!FALLBACK_FOCUS_SKIP.has(lower)) return lower;
  }
  return t || "animals";
}

function truncateOption(text: string, max: number): string {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trimEnd() + "...";
}

export function buildContextFallbackQuiz(
  context: string,
  topic: string,
  count: number,
  age = 8
): FallbackQuizQuestion[] {
  // Use different lesson facts and question shapes when model JSON cannot be parsed.
  const safeTopic = typeof topic === "string" && topic.trim() ? topic.trim().replace(/"/g, "'") : "this topic";
  const maxOptLen = age < 7 ? 70 : 110;
  const sentences = context
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanFallbackSentence(s))
    .filter(
      (s) =>
        s.length > 25 &&
        s.length < 240 &&
        /[a-zA-Z]{3,}/.test(s) &&
        !/\?\s*$/.test(s) &&
        !/^(all about|think about it|amazing fact|discover)\b/i.test(s) &&
        // Worksheet scaffolding ("Think About It / Imagine you had..."),
        // not facts a quiz can test.
        !/think about it|imagine you (had|have|could)|what are .* you could do/i.test(s)
    );
  const unique = [...new Set(sentences)];
  // Little kids get the shortest facts first — a 6-year-old should never
  // face a wall of 110-character options.
  const pool = age < 7 ? [...unique].sort((a, b) => a.length - b.length) : unique;
  const source = pool.length >= Math.min(count, 2) ? pool : unique;
  const quiz: FallbackQuizQuestion[] = [];
  const usedFoci = new Set<string>();
  const falseOptionTemplates = [
    "Something else that is not true.",
    "A different idea from outside the lesson.",
  ];
  const questionTemplates = [
    (focus: string) => `What does the lesson say about ${focus}?`,
    (focus: string) => `Which detail does the lesson give about ${focus}?`,
    (focus: string) => `What fact does the lesson give about ${focus}?`,
    (focus: string) => `Which fact about ${focus} is in the lesson?`,
  ];
  for (let i = 0; i < count; i++) {
    const sentence = source[i % Math.max(source.length, 1)] || `${safeTopic} is described in the lesson.`;
    const focus = fallbackFocus(sentence, safeTopic, usedFoci);
    usedFoci.add(focus);
    const question = questionTemplates[i % questionTemplates.length](focus);
    const correct = truncateOption(sentence, maxOptLen);
    // Prefer other real lesson sentences as distractors so options stay
    // concrete; fall back to kid-friendly negatives only when needed.
    const others = source.filter((s) => s !== sentence && truncateOption(s, maxOptLen) !== correct);
    const d1raw = others[(i + 1) % Math.max(others.length, 1)] || falseOptionTemplates[0];
    const d2raw = others[(i + 2) % Math.max(others.length, 1)] || falseOptionTemplates[1];
    const d1 = truncateOption(d1raw, maxOptLen);
    const d2 = truncateOption(d2raw === d1raw ? falseOptionTemplates[1] : d2raw, maxOptLen);
    const options = [correct, d1 === correct ? falseOptionTemplates[0] : d1, d2 === correct || d2 === d1 ? falseOptionTemplates[1] : d2];
    // Rotate correct position so it is not always first.
    const rotated = [...options.slice((i + 1) % 3), ...options.slice(0, (i + 1) % 3)];
    quiz.push({
      question,
      options: rotated,
      answer: correct,
    });
  }
  return quiz;
}

export function defaultQuizForTopic(topic: string, count = 3, context = "", age = 8): FallbackQuizQuestion[] {
  if (context && context.trim().length > 0) {
    return buildContextFallbackQuiz(context, topic, count, age);
  }
  const safeTopic = typeof topic === "string" && topic.trim() ? topic.trim().replace(/"/g, "'") : "this topic";
  return Array.from({ length: count }, (_, i) => ({
    question: `What did the lesson say about ${safeTopic} (fact ${i + 1})?`,
    options: [`A fact from the lesson`, `Something not in the lesson`, `I don't know`],
    answer: `A fact from the lesson`,
  }));
}
