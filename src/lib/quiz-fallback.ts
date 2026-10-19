// Deterministic last-resort quiz builder (no LLM). Used when the model
// returns unusable JSON — for a 6-year-old this IS the quiz she sees, so it
// must still be grammatical, clean, and matched:
// - stems use a complete multi-word phrase where possible, never a lone
//   descriptor word or a vague pronoun;
// - options are plain cleaned sentences with no markdown;
// - each option set belongs to its own stem by construction;
// - options are short enough for little kids to read.
//
// Every rule below is topic-agnostic (plain generic English: pronouns,
// verbs, glue words, phrase shapes). No lesson subject, example, or proper
// noun is hardcoded anywhere, so the same code serves any kind of data.

export type FallbackQuizQuestion = {
  question: string;
  options: string[];
  answer: string;
};

// Words that read broken after "about" and can never carry a question
// focus. Plain generic English only — pronouns, common verbs, modals,
// adverbs, determiners, question words, and app meta words. Never a topic
// noun, so nothing here favors one lesson subject over another.
const FALLBACK_FOCUS_SKIP = new Set([
  "they", "them", "their", "it", "its", "this", "that", "these", "those",
  // Pronoun contractions ("Which fact about it's…"), but NOT "what's" —
  // "about what's happening" reads fine as a stem.
  "it's", "that's", "there's", "here's", "they're", "we're", "you're",
  "he's", "she's", "we've", "you've", "they've", "i'm", "i've",
  "there", "here", "he", "she", "we", "you", "his", "her", "our", "your",
  "live", "lives", "living", "lived", "use", "uses", "used", "using", "have", "has",
  "need", "needs", "needed", "needing",
  "had", "having", "make", "makes", "made", "making", "take", "takes",
  "took", "taken", "get", "gets", "got", "give", "gives", "gave", "go",
  "goes", "went", "come", "comes", "came", "move", "moves", "moved",
  "moving", "drink", "drinks", "eat", "eats", "sleep", "sleeps", "fly",
  "swim", "run", "walk", "breathe", "breathes", "smell", "smells", "touch",
  "touches", "pick", "picks", "find", "finds", "found", "call", "calls",
  "called", "communicate", "communicates", "see", "sees", "saw", "seen",
  "look", "looks", "looked", "show", "shows", "showed", "shown", "say",
  "tell", "tells", "told", "ask", "asks", "asked", "answer", "answers",
  "answered", "help", "helps", "helped", "helping", "keep", "keeps", "kept",
  "seem", "seems",   "stand", "stands", "stood", "sit", "sits", "sat",
  "walk", "walks", "walked", "walking", "rise", "rises", "rose", "risen",
  "glide", "glides", "glided", "gliding", "love", "loves", "loved", "loving",
  "taste", "tastes", "tasted", "tasting", "bake", "bakes", "baked", "baking",
  "cook", "cooks", "cooked", "cooking", "talk", "talks", "talked", "talking",
  "shine", "shines", "shone", "shining", "float", "floats", "floated",
  "floating", "crawl", "crawls", "crawled", "crawling", "roll", "rolls",
  "rolled", "rolling", "slide", "slides", "slid", "sliding", "rest", "rests",
  "rested", "resting", "wake", "wakes", "woke", "waking", "pull", "pulls",
  "pulled", "push", "pushes", "pushed", "carry", "carries", "carried",
  "hide", "hides", "dig", "digs", "dug", "digging",
  "spin", "spins", "spinning", "become", "becomes", "stay", "stays",
  "stayed", "start", "starts", "started", "starting", "grow", "grows",
  "grew", "growing", "turn", "turns", "very", "just", "also", "more",
  "most", "many", "much", "like", "well", "different", "same", "other",
  "others", "another", "such", "own", "often", "usually", "carefully",
  "quickly", "slowly", "entirely", "too", "even", "still", "quite",
  "really", "away", "now", "again", "together", "around",
  "big", "small", "long", "short", "large", "little",
  "bigger", "smaller", "longer", "shorter", "taller", "larger",
  "largest", "smallest", "longest", "shortest", "biggest", "tallest",
  "fastest", "slowest",
  "can", "could", "will", "would", "should", "shall", "may", "might",
  "must", "ought", "are", "is", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "don",
  "with", "from", "for", "into", "over", "under", "between", "through",
  "toward", "towards", "upon", "onto", "across", "along", "beyond",
  "near", "far", "past",
  "out", "off", "down", "today", "tomorrow", "yesterday",
  "what", "when", "where", "which", "how", "why",
  "who", "lesson", "described", "says",
  // Vague placeholders a young child cannot picture.
  "some", "something", "someone", "somewhere", "everything", "nothing",
  "anything", "thing", "things", "stuff",
  // Determiners and ordinals that carry no picture on their own.
  "all", "each", "every", "both", "either", "neither", "any", "several",
  "first", "second", "third",
  // Contractions survive whitespace tokenizing with the apostrophe intact.
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "can't", "couldn't", "won't", "wouldn't", "shouldn't", "haven't",
  "hasn't", "hadn't", "i'm", "it's", "that's", "there's",
]);

// Plain-sentence cleanup for lesson text with worksheet markdown:
// a leading bullet is dropped and a "label to:" lead-in is unwrapped so the
// taught fact survives. First letter is capitalized so options never trip
// the lowercase-fragment check.
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

// Glue words may sit INSIDE a focus phrase but never start one.
const FALLBACK_GLUE = new Set(["and", "or", "of", "the", "a", "an"]);

// Question templates already join with a preposition ("…say about
// ${focus}"), so a focus that starts with one would read "about about
// what's happening".
const FALLBACK_LEADING_PREPS = new Set([
  "about", "on", "of", "in", "at", "for", "with", "to", "by", "from",
  "into", "over", "under", "after", "before", "during", "without", "around",
]);

function stripLeadingPreposition(focus: string): string {
  const words = focus.split(/\s+/);
  while (words.length > 1 && FALLBACK_LEADING_PREPS.has(words[0].toLowerCase())) {
    words.shift();
  }
  return words.join(" ");
}

// Counting words may LEAD a phrase but never continue one, which keeps
// quantities attached to their noun while cutting false joins. Generic
// counting vocabulary, no subject involved.
const FALLBACK_NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "hundred",
  "thousand", "million", "billion", "dozen",
]);

function isFallbackNumberWord(word: string): boolean {
  return FALLBACK_NUMBER_WORDS.has(word) || /^\d+(st|nd|rd|th)?$/.test(word);
}

// Descriptor words add meaning inside a phrase but picture nothing on their
// own, so a phrase made of ONLY one of these is rejected. Generic
// appearance vocabulary (colors, textures, temperatures) — never a subject
// noun, so this behaves the same for every topic.
const FALLBACK_DESCRIPTORS = new Set([
  "red", "blue", "green", "yellow", "orange", "purple", "pink", "brown",
  "black", "white", "gray", "grey", "bright", "dark", "light", "colorful",
  "golden", "silver", "round", "flat", "straight", "giant", "tiny", "huge",
  "fluffy", "rocky", "fresh", "soft", "hard", "smooth", "rough", "heavy",
  "sweet", "clean", "dirty", "loud", "quiet", "fast", "slow", "new", "old",
  "young", "good", "bad", "hot", "cold", "warm", "cool", "chilly",
]);

function isFallbackContentWord(word: string): boolean {
  if (word.length < 3 || !/[a-z0-9]/.test(word)) return false;
  // OCR/lesson text often uses curly apostrophes: "it’s" must still hit
  // the "it's" skip entry.
  const normalized = word.replace(/[\u2018\u2019\u02BC]/g, "'");
  if (FALLBACK_FOCUS_SKIP.has(normalized)) return false;
  if (FALLBACK_GLUE.has(normalized)) return false;
  return true;
}

// Proper-noun signal with zero hardcoded names: a word capitalized in the
// MIDDLE of a sentence is almost always a name, while a capitalized FIRST
// word is just sentence case. Collected from the surrounding text so a name
// keeps its capital wherever it appears in the lesson.
function fallbackProperForms(text: string): Map<string, string> {
  const forms = new Map<string, string>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence
      .replace(/[.?!,;:()[\]{}"]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    tokens.forEach((token, index) => {
      const clean = token.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
      if (clean.length < 3 || !/^[A-Z][a-z]/.test(clean)) return;
      if (index === 0) return;
      const lower = clean.toLowerCase();
      if (!forms.has(lower)) forms.set(lower, clean);
    });
  }
  return forms;
}

// A concrete phrase for the stem, built only from the sentence's own word
// order and generic word shapes — no topic word list anywhere:
// - gather up to 3 consecutive content words, letting glue words ride along;
// - a comma ends the phrase unless a descriptor touches it (lists split,
//   stacked descriptors stay together);
// - a counting word may lead but never continue a phrase;
// - a lone descriptor is rejected;
// - a preceding article is kept with the phrase;
// - names keep whatever capitalization the lesson itself uses;
// - longest phrase wins, earliest position breaks ties, and no focus is
//   reused within one quiz.
export function fallbackFocus(
  sentence: string,
  topic: string,
  used: Set<string>,
  context = "",
): string {
  // Remember which comma-segment each token came from so the builder can
  // tell list commas apart from descriptor commas.
  const tokens: string[] = [];
  const segIds: number[] = [];
  sentence.split(",").forEach((segment, seg) => {
    for (const token of segment
      .replace(/[.?!;()[\]{}":]/g, " ")
      .split(/\s+/)
      .filter(Boolean)) {
      tokens.push(token);
      segIds.push(seg);
    }
  });
  const lowers = tokens.map((token) => token.toLowerCase());
  const proper = fallbackProperForms(context || sentence);

  const render = (index: number): string => {
    const lower = lowers[index];
    const named = proper.get(lower);
    if (named) return named;
    // Sentence case tells nothing: lowercase the first word. Words already
    // lowercase mid-sentence render unchanged.
    return index === 0 ? lower : tokens[index];
  };

  const buildPhrase = (
    start: number,
  ): { text: string; content: number; proper: boolean } | null => {
    const words: string[] = [];
    // Keep a preceding article with the phrase.
    if (
      start > 0 &&
      (lowers[start - 1] === "the" ||
        lowers[start - 1] === "a" ||
        lowers[start - 1] === "an")
    ) {
      words.push(lowers[start - 1]);
    }
    let content = 0;
    let properHit = false;
    let lastContent = "";
    for (let j = start; j < tokens.length && words.length < 6; j++) {
      if (j > start && segIds[j] !== segIds[j - 1]) {
        let next = "";
        for (let s = j; s < tokens.length; s++) {
          if (FALLBACK_GLUE.has(lowers[s])) continue;
          if (isFallbackContentWord(lowers[s])) next = lowers[s];
          break;
        }
        if (
          !FALLBACK_DESCRIPTORS.has(lastContent) &&
          !FALLBACK_DESCRIPTORS.has(next)
        ) {
          break;
        }
      }
      const lw = lowers[j];
      if (isFallbackContentWord(lw)) {
        if (content > 0 && isFallbackNumberWord(lw)) break;
        words.push(render(j));
        content += 1;
        lastContent = lw;
        if (proper.has(lw)) properHit = true;
        if (content >= 3) break;
      } else if (FALLBACK_GLUE.has(lw) && content > 0) {
        // Glue must sit between content words, never stack or dangle.
        const prev = words[words.length - 1];
        if (FALLBACK_GLUE.has(prev)) break;
        words.push(lw);
      } else {
        break;
      }
    }
    // Drop a dangling glue tail.
    while (words.length > 0 && FALLBACK_GLUE.has(words[words.length - 1])) {
      words.pop();
    }
    if (content === 0) return null;
    // A lone descriptor pictures nothing.
    if (content === 1 && FALLBACK_DESCRIPTORS.has(lowers[start])) {
      return null;
    }
    // Stacked descriptors read joined.
    const joined: string[] = [];
    for (const word of words) {
      const prev = joined[joined.length - 1];
      if (
        prev !== undefined &&
        FALLBACK_DESCRIPTORS.has(prev.toLowerCase()) &&
        FALLBACK_DESCRIPTORS.has(word.toLowerCase())
      ) {
        joined.push("and");
      }
      joined.push(word);
    }
    const text = joined.join(" ").replace(/\s+/g, " ").trim();
    // Keep stems short enough for young readers.
    if (!text || text.length > 34) return null;
    return { text, content, proper: properHit };
  };
  type Cand = { focus: string; score: number; pos: number };
  const cands: Cand[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (!isFallbackContentWord(lowers[k])) continue;
    const phrase = buildPhrase(k);
    if (!phrase || used.has(phrase.text)) continue;
    cands.push({
      focus: phrase.text,
      score: phrase.content + (phrase.proper ? 1 : 0),
      pos: k,
    });
  }
  // Longest phrase wins; earliest position breaks ties so the sentence's
  // main subject still beats a later detail of equal weight.
  cands.sort((a, b) => b.score - a.score || a.pos - b.pos);
  if (cands.length > 0) {
    const stripped = stripLeadingPreposition(cands[0].focus);
    if (stripped && !used.has(stripped)) return stripped;
  }
  // No concrete phrase could be built from the sentence's own words (for
  // example "It helps them do so many things." is all pronouns and glue).
  // Falling back to the topic title would ask "What is true about <topic>?"
  // while the correct option talks about "it" — the stem and the answer are
  // out of sync, and every other lesson sentence becomes a true distractor.
  // Return empty so the caller can pick a sentence that does yield a focus.
  return "";
}

function truncateOption(text: string, max: number): string {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 3);
  // Prefer a clause boundary: "Warm air takes up more space than cold air,"
  // reads complete without an ellipsis; a bare space cut does not.
  const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "), cut.lastIndexOf(" - "), cut.lastIndexOf(" — "));
  if (clause > 30) return cut.slice(0, clause).replace(/[,;]\s*$/, "").trimEnd();
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
        s.length > 20 &&
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
  // face a wall of 110-character options. Every age prefers sentences that
  // already fit maxOptLen, so options are never cut mid-thought; oversize
  // sentences are only used when there aren't enough fitting ones.
  const ordered = age < 7 ? [...unique].sort((a, b) => a.length - b.length) : unique;
  const fitting = ordered.filter((s) => s.length <= maxOptLen);
  const source =
    fitting.length > 0
      ? [...fitting, ...ordered.filter((s) => s.length > maxOptLen)]
      : ordered;
  // No usable lesson sentence at all: let defaultQuizForTopic emit its generic
  // template quiz instead of a single filler question.
  if (source.length === 0) return [];
  const quiz: FallbackQuizQuestion[] = [];
  const usedFoci = new Set<string>();
  const falseOptionTemplates = [
    "Something else that is not true.",
    "A different idea from outside the lesson.",
  ];
  // Little kids get short plain stems ("Which one is true about ...?");
  // older kids keep the lesson-grounded wording. Either way the focus is
  // always a complete phrase, never a lone descriptor or a vague pronoun.
  const questionTemplates =
    age < 7
      ? [
          (focus: string) => `What do we know about ${focus}?`,
          (focus: string) => `Which one is true about ${focus}?`,
          (focus: string) => `What is true about ${focus}?`,
          (focus: string) => `Which one tells about ${focus}?`,
        ]
      : [
          (focus: string) => `What does the lesson say about ${focus}?`,
          (focus: string) => `Which detail does the lesson give about ${focus}?`,
          (focus: string) => `What fact does the lesson give about ${focus}?`,
          (focus: string) => `Which fact about ${focus} is in the lesson?`,
        ];
  // Names are detected across the whole lesson text (a mid-sentence capital
  // in one sentence keeps the same word capitalized everywhere else), so the
  // full cleaned text — including short sentences the quiz pool skips —
  // travels with every focus lookup.
  const properScope = sentences.join(" ");

  // Crude singular/plural fold so a focus word ("family", "trunk") still
  // matches its plural in a distractor ("families", "trunks").
  const foldWord = (word: string): string => {
    const w = word.replace(/['\u2018\u2019\u02BC]s?$/, "");
    if (/ies$/.test(w)) return w.replace(/ies$/, "y");
    if (/(?:ss|sh|ch|x|z)es$/.test(w)) return w.replace(/es$/, "");
    if (/s$/.test(w) && !/ss$/.test(w)) return w.replace(/s$/, "");
    return w;
  };
  // Content words inside a focus phrase — a distractor that shares any of
  // them may also be true about the focus, so it cannot be used.
  const focusWords = (focus: string): string[] => {
    const words = focus
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9']/g, ""))
      .filter((w) => isFallbackContentWord(w))
      .map(foldWord)
      .filter(Boolean);
    return [...new Set(words)];
  };
  // A focus equal to the topic itself ("What is true about Elephants?") makes
  // every lesson sentence a true option — real-sentence distractors are
  // unsafe there, so use the kid-friendly negatives instead.
  const topicWords = focusWords(safeTopic).join(" ");
  const isTopicFocus = (focus: string): boolean => {
    const f = focusWords(focus).join(" ");
    return (
      f.length > 0 &&
      (f === topicWords ||
        f.startsWith(topicWords + " ") ||
        topicWords.startsWith(f + " "))
    );
  };
  // A sentence whose subject is a bare pronoun ("It helps them …", "They can
  // smell …") is referential: it may be about the focus without naming it, so
  // it is never safe as a distractor.
  const REFERENTIAL_START =
    /^(it|its|it's|they|them|their|they're|this|that|these|those|he|she|him|her|we|us|our|you|your)\b/i;
  const sentenceWords = (text: string): Set<string> =>
    new Set(
      (text.toLowerCase().match(/[a-z0-9']+/g) || [])
        .filter((w) => isFallbackContentWord(w))
        .map(foldWord)
    );

  for (let i = 0; i < count; i++) {
    // Walk forward to the next sentence whose own words build a concrete
    // focus, so the stem names something the correct option actually says.
    let sentence = "";
    let focus = "";
    const pool = Math.max(source.length, 1);
    for (let step = 0; step < pool; step++) {
      const candidate = source[(i + step) % pool] || `${safeTopic} is described in the lesson.`;
      const found = fallbackFocus(candidate, safeTopic, usedFoci, properScope);
      if (found) {
        sentence = candidate;
        focus = found;
        break;
      }
    }
    // No focusable sentence left: stop rather than ask a stem its options
    // cannot match (the reported "What is true about Elephant?" bug).
    if (!focus) break;
    usedFoci.add(focus);

    const question = questionTemplates[quiz.length % questionTemplates.length](focus);
    const correct = truncateOption(sentence, maxOptLen);
    // Prefer other real lesson sentences as distractors so options stay
    // concrete — but never one that is also about the focus, and never one
    // whose subject is a pronoun that could refer to the focus. Those cases
    // fall back to kid-friendly negatives so exactly one option is true.
    const wanted = focusWords(focus);
    const others = isTopicFocus(focus)
      ? []
      : source.filter((s) => {
          if (s === sentence || truncateOption(s, maxOptLen) === correct) return false;
          if (REFERENTIAL_START.test(s)) return false;
          const words = sentenceWords(s);
          return !wanted.some((w) => words.has(w));
        });
    // Distractors prefer sentences that fit the length cap outright, so an
    // oversize tail sentence never gets space-cut with a dangling "...".
    const fittingOthers = others.filter((s) => s.length <= maxOptLen);
    const dPool = fittingOthers.length >= 2 ? fittingOthers : others;
    const pickFalse = (avoid: string[]): string =>
      falseOptionTemplates.find((f) => !avoid.includes(f)) || falseOptionTemplates[0];
    const d1raw = dPool[(i + 1) % Math.max(dPool.length, 1)] ?? pickFalse([correct]);
    const d2raw = dPool[(i + 2) % Math.max(dPool.length, 1)] ?? pickFalse([correct, d1raw]);
    const d1 = truncateOption(d1raw, maxOptLen);
    const d2 = truncateOption(d2raw === d1raw ? pickFalse([correct, d1]) : d2raw, maxOptLen);
    const options = [
      correct,
      d1 === correct ? pickFalse([correct, d2]) : d1,
      d2 === correct || d2 === d1 ? pickFalse([correct, d1]) : d2,
    ];
    // Rotate correct position so it is not always first.
    const rotated = [...options.slice(quiz.length % 3), ...options.slice(0, quiz.length % 3)];
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
    const fromContext = buildContextFallbackQuiz(context, topic, count, age);
    // Every sentence was pronoun-only / unfocusable: keep the generic
    // template quiz instead of returning an empty or out-of-sync quiz.
    if (fromContext.length > 0) return fromContext;
  }
  const safeTopic = typeof topic === "string" && topic.trim() ? topic.trim().replace(/"/g, "'") : "this topic";
  return Array.from({ length: count }, (_, i) => ({
    question: `What did the lesson say about ${safeTopic} (fact ${i + 1})?`,
    options: [`A fact from the lesson`, `Something not in the lesson`, `I don't know`],
    answer: `A fact from the lesson`,
  }));
}
