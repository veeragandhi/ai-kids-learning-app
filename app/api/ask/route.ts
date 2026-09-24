import { NextResponse } from "next/server";
import { generateAnswer } from "@/lib/ai";
import { cleanRetrievalQuery, contentTokens, getRelevantContext, stemWord } from "@/lib/retrieval";
import { OCR_MARKER_GUARD } from "@/lib/ocr";

type AskRequest = {
  question?: string;
  age?: number;
  mode?: "question" | "answer" | "explanation";
  questionType?: "guided" | "creative";
  studentAnswer?: string;
  explanation?: string;
  guidingQuestion?: string;
  conversation?: ConversationTurn[];
  // Lesson-linked Ask: the displayed lesson is the child's actual learning
  // context. source === "lesson" makes lessonText the primary (and only)
  // grounding context. Omitted/"standalone" keeps document retrieval.
  source?: "lesson" | "standalone";
  lessonText?: string;
};

type ConversationTurn = {
  role: "child" | "assistant";
  content: string;
};

type LearnerState =
  | "correct_and_explained"
  | "correct_but_no_reasoning"
  | "partially_correct"
  | "misconception"
  | "don't_know"
  | "don't_remember"
  | "off_topic"
  | "guessing";

type AnswerGrade = {
  responseState: LearnerState;
  correctness: "correct" | "partial" | "incorrect";
  feedback: string;
  nextPrompt: string;
  // Set when the exchange should end gracefully even though the child was
  // not merely uncertain (unanswerable question, repeated prompt, explicit
  // escalation). The handler maps this to continueLearning: false.
  graceful?: boolean;
};

function conversationTurns(body: AskRequest) {
  const previous = Array.isArray(body.conversation)
    ? body.conversation.filter(
        (turn): turn is ConversationTurn =>
          Boolean(turn) &&
          (turn.role === "child" || turn.role === "assistant") &&
          typeof turn.content === "string" &&
          turn.content.trim().length > 0,
      )
    : [];

  return previous.concat(
    body.mode === "answer"
      ? [{ role: "child", content: (body.studentAnswer || "").trim() }]
      : body.mode === "explanation"
        ? [{ role: "child", content: (body.explanation || "").trim() }]
        : [{ role: "child", content: (body.question || "").trim() }],
  );
}

function withConversation(
  body: AskRequest,
  assistantTurns: string[],
  response: Record<string, unknown>,
) {
  const conversation = conversationTurns(body).concat(
    assistantTurns
      .filter((content) => content.trim().length > 0)
      .map((content) => ({ role: "assistant" as const, content })),
  );

  return { ...response, conversation };
}

function repairJsonText(text: string) {
  return text
    .replace(/“|”/g, '"')
    .replace(/‘|’/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\bgu[iy]ldingQuestion\b/gi, "guidingQuestion")
    .replace(/\bgu[iy]lding\b/gi, "guiding");
}

function sanitizeJson(raw: string) {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const trimmed = cleaned.trim();
  if (!trimmed) return null;

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = trimmed.slice(first, last + 1);
  const repaired = repairJsonText(candidate);

  try {
    return JSON.parse(repaired);
  } catch {
    try {
      return JSON.parse(candidate);
    } catch {
      console.error("[ask] JSON parse failed, raw response:", raw);
      return null;
    }
  }
}

function extractField(raw: string, field: string) {
  const regex = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i");
  const match = raw.match(regex);
  if (!match) return null;

  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function normalizeResponseType(mode: string, parsedType?: string) {
  const type = (parsedType || "").trim().toLowerCase();

  if (mode === "answer") {
    return "evaluation";
  }

  if (mode === "explanation") {
    return "explanationFeedback";
  }

  if (
    type.includes("guiling") ||
    type.includes("guidding") ||
    type.includes("guiding") ||
    type.includes("question")
  ) {
    return "guidingQuestion";
  }

  return "guidingQuestion";
}

function isUncertainAnswer(text: string) {
  // Match uncertainty phrases with flexible spelling
  // Matches: dont, don't, don.t, rmember, remember, remeber, forgot, etc.
  const patterns = [
    /i\s+(?:don'?t|do\s*n?t|dont|don\.t)\s+(?:know|remember|rmember|remeber)/i,
    /i\s+(?:don'?t|do\s*n?t|dont|don\.t)\s+(?:understand|get|it)/i,
    /can'?t\s+remember/i,
    /cannot\s+remember/i,
    /forgot/i,
    /not\s+sure/i,
    /no\s+idea/i,
    /how\s+i\s+know/i,
    /that'?s\s+all\s+(?:i|we)\s+(?:remember|recall|know)/i,
  ];
  return patterns.some((p) => p.test(text));
}

function contextMatchesQuestion(context: string, question: string): boolean {
  const questionTokens = new Set(contentTokens(question));
  const contextTokens = new Set(contentTokens(context));

  if (questionTokens.size === 0 || contextTokens.size === 0) {
    return true;
  }

  const overlap = Array.from(questionTokens).filter((token) => contextTokens.has(token)).length;
  const minOverlap = Math.max(1, Math.ceil(questionTokens.size * 0.25));
  const matches = overlap >= minOverlap;
  
  console.log(`[contextMatch] question: "${question.substring(0, 40)}" qTokens: ${questionTokens.size} overlap: ${overlap}/${minOverlap} matches: ${matches}`);

  return matches;
}

function hasReasoning(text: string) {
  return /\b(because|so|since|which means|this shows|that tells me)\b/i.test(text);
}

function isGuess(text: string) {
  return /\b(i\s+(guess|think)|maybe|probably|perhaps)\b/i.test(text);
}

function isDirectAnswerRequest(text: string) {
  return /\b(just tell me|tell me the answer|give me the answer|what is the answer)\b/i.test(text);
}

function normalizeQuestionType(value: unknown, fallback: "guided" | "creative") {
  return value === "creative" ? "creative" : fallback;
}

function looksLikeEnglishText(text: string) {
  if (!text) return false;
  const asciiOnly = /^[\p{ASCII}\s.,!?"'()\-]+$/u.test(text);
  if (!asciiOnly) return false;

  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  return words.length >= 1;
}

function normalizeForComparison(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenSetOverlap(a: string[], b: string[]) {
  const other = new Set(b);
  return a.filter((token) => other.has(token));
}

function isTooSimilarToOriginal(generatedQuestion: string, originalQuestion: string) {
  const generated = normalizeForComparison(generatedQuestion);
  const original = normalizeForComparison(originalQuestion);

  if (!generated || !original) return false;
  if (generated === original) return true;
  if (generated.includes(original) || original.includes(generated)) return true;

  const generatedTokens = generated.split(/\s+/);
  const originalTokens = original.split(/\s+/);
  const intersection = generatedTokens.filter((token) => originalTokens.includes(token)).length;
  const union = new Set([...generatedTokens, ...originalTokens]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const startsWithYesNoWord = /^(can|could|do|does|did|is|are|was|were|will|would)\b/.test(generated);

  return jaccard >= 0.85 || (startsWithYesNoWord && generatedTokens.length <= 8);
}

function isMalformedGuidingQuestion(text: string) {
  return /\b(?:about|on)\s+(?:think|thinking|the lesson|the question|the answer)\b/i.test(text);
}

const VAGUE_LIST_WORDS = new Set([
  "several", "thing", "things", "well", "different", "job", "jobs", "way", "ways",
  "rest", "own", "help", "helps", "also",
]);

const ASK_META_WORDS = new Set([
  "think", "thinking", "lesson", "detail", "question", "answer", "clue", "useful",
  "discover", "imagine", "remember", "idea", "ideas", "about",
]);

function extractListItems(text: string) {
  const lists: string[][] = [];
  const patterns = [
    /\b(?:need|needs|needed)\s+([^.?!]+)/gi,
    /\b(?:use|uses|used)\s+(?:its\s+\w+\s+)?(?:for\s+)?([^.?!]+)/gi,
    /\blive in\s+([^.?!]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const parts = match[1]
        .split(/,|;|\/|\band\b|\bor\b/i)
        .map((part) => cleanFactPhrase(part))
        .filter((part) => {
          const tokens = contentTokens(part).filter((token) => !VAGUE_LIST_WORDS.has(token));
          return tokens.length > 0;
        });
      if (parts.length > 0) lists.push(parts);
    }
  }

  return lists;
}

// List fragments are interpolated into child-facing feedback and summaries,
// so they must read cleanly: strip bullets, "X to:" lead-ins left over from
// captures like "their trunks to: * Smell food", and stray spacing/case.
// (Fixes "The lesson does say their trunks to    Smell food.")
function cleanFactPhrase(part: string): string {
  let out = String(part || "")
    .replace(/[*•\-–—]+/g, " ")
    .replace(/^\s*(?:their|its|his|her|our)\s+\w+\s+to\s*:\s*/i, "")
    .replace(/^\s*\w+\s+to\s*:\s*/i, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^[A-Z]/.test(out)) out = out.charAt(0).toLowerCase() + out.slice(1);
  return out;
}

function answerConceptTokens(text: string) {
  const aliases: Record<string, string> = {
    breathe: "breath",
    breathing: "breath",
    breathed: "breath",
    african: "africa",
    asian: "asia",
    sound: "sound",
    sounds: "sound",
    use: "use",
    uses: "use",
    used: "use",
    using: "use",
  };

  return contentTokens(text).map((token) => aliases[token] || token);
}

function listItemMatched(studentAnswer: string, item: string) {
  const answerTokens = new Set(answerConceptTokens(studentAnswer));
  const itemTokens = answerConceptTokens(item).filter((token) => !VAGUE_LIST_WORDS.has(token));
  return itemTokens.length > 0 && itemTokens.every((token) => answerTokens.has(token));
}

function bestFactList(context: string, question: string) {
  const questionTokens = new Set(contentTokens(question));
  const sentences = context.split(/(?<=[.!?])\s+/);
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      overlap: contentTokens(sentence).filter((token) => questionTokens.has(token)).length,
    }))
    .sort((a, b) => b.overlap - a.overlap);

  const pickLongest = (text: string) => {
    const lists = extractListItems(text);
    if (lists.length === 0) return [];
    return lists.sort((a, b) => b.length - a.length)[0];
  };

  // Relevance gate: a sentence below the best sentence-level overlap may
  // only supply the fact list through a shared NON-generic query token.
  // Measured on the dino query ("Why did Stegosaurus live before T. rex?",
  // tokens [stegosauru, live, before, rex], best sentence overlap 2): the
  // off-topic "Some animals live in forests" (sole shared token "live")
  // won after the correct overlap-2 dinosaur sentences failed the list
  // pattern match. But the same below-best position carries the legitimate
  // trunk-uses list for "Why don't humans have trunks?" (sole shared token
  // "trunk"), and for the answerable trunk query (overlap 3 vs best 4 via
  // "its"/"their" stemming) — so a pure overlap cutoff in either direction
  // breaks one of the two. The measured difference is the token itself:
  // generic verbs ("live", "have", ...) cross topics freely, while a
  // distinctive noun ("trunk") keeps the evidence on-topic. The ungated
  // whole-context fallback had the same hole (it returned "forests" when
  // the loop found nothing), so it returns [] instead — callers already
  // fall back to the shared-token clue ("rex") or a key-token summary.
  const GENERIC_EVIDENCE_SKIP = new Set([
    ...ANSWERABILITY_VERB_SKIP,
    "live", "liv", "like", "lik",
  ]);
  const bestOverlap = ranked.length > 0 ? ranked[0].overlap : 0;
  const minOverlap = Math.max(1, bestOverlap - 1);
  for (const item of ranked) {
    if (item.overlap === 0 || item.overlap < minOverlap) continue;
    if (item.overlap < bestOverlap) {
      const shared = contentTokens(item.sentence).filter(
        (token) => questionTokens.has(token) && !GENERIC_EVIDENCE_SKIP.has(token),
      );
      if (shared.length === 0) continue;
    }
    const window = sentences.slice(item.index, item.index + 2).join(" ");
    const list = pickLongest(window);
    if (list.length > 0) return list;
  }

  return [];
}

function pickClueTerm(context: string, question: string) {
  const questionTokens = contentTokens(question).filter((token) => !ASK_META_WORDS.has(token));
  const contextTokenList = contentTokens(context);
  const shared = [...questionTokens].reverse().find((token) => contextTokenList.includes(token));
  // Return the original word from the context, not the stemmed token
  // (so the child sees "breathing", never "breath").
  if (shared) return findOriginalWord(context, shared);

  const fact = bestFactList(context, question)
    .flatMap((item) => contentTokens(item).filter((token) => !ASK_META_WORDS.has(token)));
  if (fact.length > 0) {
    return findOriginalWord(context, fact[0]);
  }

  const fallback = contextTokenList.find((token) => !ASK_META_WORDS.has(token)) || "this";
  return findOriginalWord(context, fallback);
}

function pickEvidenceTerm(context: string, question: string) {
  const fact = bestFactList(context, question)[0];
  if (fact) {
    const token = contentTokens(fact).find((item) => item.length > 2);
    if (token) return findOriginalWord(context, token);
  }
  return pickClueTerm(context, question);
}

function findOriginalWord(context: string, stemmedToken: string): string {
  // Find the original (non-stemmed) form of a word in the context
  const lower = context.toLowerCase();
  const match = lower.match(new RegExp(`\\b(\\w*${stemmedToken}\\w*)\\b`, "i"));
  return match ? match[1] : stemmedToken;
}

function buildContextGuidingQuestion(
  context: string,
  question: string,
  questionType: "guided" | "creative"
) {
  const topic = pickClueTerm(context, question);
  const evidence = pickEvidenceTerm(context, question);

  if (questionType === "creative") {
    return `Can you invent your own example about ${topic} using the clue "${evidence}" from the lesson?`;
  }

  if (topic === evidence) {
    return `What does the lesson say about ${topic}?`;
  }

  return `What clue does the lesson give about ${topic}? Look for the part about ${evidence}.`;
}

function relevantContextTokens(context: string, question: string) {
  const questionTokens = new Set(contentTokens(question));
  const sentences = context.split(/(?<=[.!?])\s+/);
  const relevant = sentences.filter((sentence) =>
    contentTokens(sentence).some((token) => questionTokens.has(token))
  );
  return new Set(contentTokens(relevant.join(" ") || context));
}

function isOffTopicAnswer(context: string, question: string, studentAnswer: string) {
  const answerTokens = contentTokens(studentAnswer);
  const questionTokens = new Set(contentTokens(question));
  const relevantTokens = relevantContextTokens(context, question);
  const supportedTokens = answerTokens.filter((token) => relevantTokens.has(token));

  if (answerTokens.length <= 2 && answerTokens.some((token) => relevantTokens.has(token))) {
    return false;
  }

  if (supportedTokens.length >= 2) {
    return false;
  }

  // A wrong candidate that names the question's own subject ("plants need
  // rocks") is an attempted answer (misconception), not a topic change.
  // Only answers sharing nothing with the question ("fish..." for a plants
  // question) count as off-topic.
  const substantiveQuestion = new Set(
    [...questionTokens].filter((token) => token.length >= 4),
  );
  if (answerTokens.some((token) => substantiveQuestion.has(token))) {
    return false;
  }

  const foreign = answerTokens.filter((token) => !relevantTokens.has(token) && !questionTokens.has(token));
  return foreign.length >= 2;
}

function hasRelevantContextTokens(context: string, question: string, studentAnswer: string): boolean {
  // Check if the student answer contains SUBSTANTIVE content from the context
  // (not just uncertainty words like "dont", "remember")
  const relevantTokens = relevantContextTokens(context, question);
  const answerTokens = contentTokens(studentAnswer);
  
  // Filter out common uncertainty/transition words that aren't substantive content
  const skipWords = new Set([
    'dont', 'don\'t', 'do', 'not', 'know', 'remember', 'forgot', 'can', 'could',
    'maybe', 'perhaps', 'probably', 'think', 'guess', 'sure', 'i', 'me', 'my',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'and', 'or', 'but',
    'it', 'this', 'that', 'what', 'how', 'why', 'when', 'where', 'who',
    'you', 'we', 'they', 'them', 'their', 'yes', 'no', 'ok', 'okay',
    'please', 'tell', 'show', 'help', 'me', 'out', 'more', 'other', 'also',
    'maybe', 'think', 'feel', 'thought', 'said', 'says', 'like', 'just',
  ]);
  
  // Only count substantive content words
  const substantiveTokens = answerTokens.filter((token) => 
    token.length >= 3 && !skipWords.has(token)
  );
  
  const supportedSubstantiveTokens = substantiveTokens.filter((token) => 
    relevantTokens.has(token)
  );
  
  // Need at least 2 substantive content tokens to be considered relevant
  return supportedSubstantiveTokens.length >= 2;
}

function extractContentAfterUncertainty(text: string): string {
  // Extract the content after uncertainty phrases like "I don't remember"
  // This allows us to process what the child is actually trying to say
  const patterns = [
    /i\s+(?:don't|do not|do\s*not|don.t|doent)\s+(?:remember|recall|know)\s*[,.:;]?\s*(.+)/i,
    /i\s+(?:can't|cannot)\s+(?:remember|recall|know)\s*[,.:;]?\s*(.+)/i,
    /forgot\s*[,.:;]?\s*(.+)/i,
    /i\s+(?:don't|do not|don.t)\s+know\s*[,.:;]?\s*(.+)/i,
    /not sure\s*[,.:;]?\s*(.+)/i,
    /i\s+don.t\s+understand\s*[,.:;]?\s*(.+)/i,
    /i\s+do\s*not\s+understand\s*[,.:;]?\s*(.+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const content = match[1].trim();
      // Only return content that has at least 2 words
      if (content.split(/\s+/).length >= 2) {
        return content;
      }
    }
  }
  
  return "";
}
function joinListGrammar(items: string[]): string {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(", ")}, and ${cleaned[cleaned.length - 1]}`;
}

function buildAnswerSummary(context: string, question: string): string {
  // Build a summary of the key points from this document to help the child.
  const factList = bestFactList(context, question);

  if (factList.length > 0) {
    const formatted = joinListGrammar(factList.slice(0, 4));
    return `Here is what the lesson says: ${formatted}.`;
  }

  // Fallback: extract key tokens from the question and context
  const keyTokens = relevantContextTokens(context, question);
  const keyWords = Array.from(keyTokens).slice(0, 5);

  if (keyWords.length > 0) {
    return `From the lesson, the important details are: ${joinListGrammar(keyWords)}.`;
  }

  return "Keep exploring the lesson to discover more!";
}

function buildRemainingDetailsPrompt(context: string, question: string) {
  const clue = pickClueTerm(context, question);
  return `What other detail does the lesson give about ${clue}?`;
}

// Asking "what other detail?" verbatim forever feels robotic and is what
// frustrated the trunk conversation. The second time a partial answer would
// repeat the same prompt, end gracefully with a grounded summary instead.
function remainingDetailsOrSummary(
  context: string,
  question: string,
  previousAssistant: string[],
): { nextPrompt: string; gracefulSummary: string | null } {
  if (previousAssistant.filter((turn) => turn.includes("What other detail")).length >= 2) {
    return { nextPrompt: GRACEFUL_END_PROMPT, gracefulSummary: buildAnswerSummary(context, question) };
  }
  return { nextPrompt: buildRemainingDetailsPrompt(context, question), gracefulSummary: null };
}

function gracefulPartialEnd(summary: string): AnswerGrade {
  return {
    responseState: "don't_remember" as const,
    correctness: "partial" as const,
    feedback: `Great try thinking about it! ${summary}`,
    nextPrompt: GRACEFUL_END_PROMPT,
    graceful: true,
  };
}

// A frustrated child explicitly asking for the answer ("I want the answer",
// "this does not answer my question") should get the graceful summary, not
// another round of grading as a misconception.
function isExplicitAnswerRequest(text: string) {
  return /\b(i want (the )?answer|just tell me|tell me (the answer|now|please)|give me the answer|this does (not|n.t) answer|you('re| are) not (answering|listening)|i don'?t like this|not related to|answer my question|not what i asked|that'?s not what i asked)\b/i.test(text);
}

// Words that carry no entity meaning for answerability checks.
const ANSWERABILITY_VERB_SKIP = new Set([
  "have", "has", "had", "hav", "having",
  "make", "makes", "made", "making",
  "take", "takes", "took", "taking",
  "get", "gets", "got", "getting",
  "give", "gives", "gave", "giving",
  "go", "goes", "went", "going",
  "come", "comes", "came", "coming",
  "do", "does", "did", "don",
  "is", "are", "was", "were", "be",
  "can", "could", "will", "would", "should",
]);

// Entities lessons never cover: a question about one of these is
// unanswerable from any lesson that never mentions it ("why don't humans
// have trunks?" with an elephants-only lesson).
const ABSENT_ENTITY_WORDS = new Set([
  "human", "humans", "person", "people", "mankind",
]);

const CONTENT_VERB_STEMS = new Set([
  "have", "live", "eat", "drink", "grow", "make", "take", "get",
  "give", "go", "come", "sleep", "fly", "swim", "run", "walk",
  "breathe", "breath", "use", "need", "pick", "smell", "touch",
]);

// Returns the missing entity word when the child's question asks about
// something the retrieved context never mentions, else null. Narrow by
// design: only fires for (a) absent-entity words (humans/people), or
// (b) why/how-come + negation about a subject-position entity that is
// missing ("why don't birds have trunks?"). A missing object
// ("why does Stegosaurus have plates?") stays answerable so the child can
// still explore what the lesson DOES say about the subject.
function unanswerableEntityFromContext(context: string, question: string): string | null {
  const contextSet = new Set(contentTokens(context));
  const substantive = contentTokens(question).filter(
    (token) =>
      token.length >= 4 &&
      !ANSWERABILITY_VERB_SKIP.has(token) &&
      !ASK_META_WORDS.has(token) &&
      !VAGUE_LIST_WORDS.has(token),
  );
  const missing = substantive.filter((token) => !contextSet.has(token));
  if (missing.length === 0) return null;

  const absentEntity = missing.find((token) => ABSENT_ENTITY_WORDS.has(token));
  if (absentEntity) return absentEntity;

  const text = String(question || "");
  const isWhy = /^\s*why\b/i.test(text) || /\bhow come\b/i.test(text);
  const negated = /\b(don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|couldn'?t|not|never)\b/i.test(text);
  if (!isWhy || !negated) return null;

  // Subject test: the missing entity comes before the main content verb
  // ("humans ... have ... trunks" -> subject; "Stegosaurus ... have ...
  // plates" -> plates is the object, so it stays answerable).
  const rawWords = (text.toLowerCase().match(/[a-z]+/g) || []).map(stemWord);
  const verbIdx = rawWords.findIndex((word) => CONTENT_VERB_STEMS.has(word));
  const firstMissing = rawWords.findIndex((word) => missing.includes(word));
  if (firstMissing !== -1 && (verbIdx === -1 || firstMissing < verbIdx)) {
    return rawWords[firstMissing];
  }
  return null;
}

// Lesson-linked Ask: is the child's question covered by the DISPLAYED
// lesson at all? Strict token check, not similarity: anything beyond the
// lesson's own words is honestly unknown ("I don't know based on this
// lesson"). Standalone document Q&A never uses this gate.
function questionCoveredByLesson(lessonText: string, question: string): boolean {
  const lessonSet = new Set(contentTokens(lessonText));
  const substantive = contentTokens(question).filter(
    (token) =>
      token.length >= 4 &&
      !ANSWERABILITY_VERB_SKIP.has(token) &&
      !ASK_META_WORDS.has(token) &&
      !VAGUE_LIST_WORDS.has(token),
  );
  if (substantive.length === 0) return true;
  return substantive.every((token) => lessonSet.has(token));
}



const GRACEFUL_END_PROMPT = "Want to try another question from the lesson?";

// Extra-claim guardrails: meta/vague words are never "unsupported extras"
// ("the text says so" must not flag "text"). Only concrete content words
// absent from BOTH lesson and question count ("help us to play" -> "play").
const EXTRA_CLAIM_SKIP = new Set([
  ...VAGUE_LIST_WORDS,
  "lesson", "text", "sentence", "page", "book", "story", "picture",
  "says", "said", "say", "answer", "question", "think", "thought",
  "know", "remember", "school", "word", "words",
  "use", "used", "uses", "using",
  "job", "jobs",
]);

function unsupportedExtras(context: string, question: string, studentAnswer: string): string[] {
  const contextSet = new Set(answerConceptTokens(context));
  const questionSet = new Set(answerConceptTokens(question));
  const seen = new Set<string>();
  const extras: string[] = [];
  for (const word of String(studentAnswer).toLowerCase().match(/[a-z]+/g) || []) {
    if (word.length < 4 || EXTRA_CLAIM_SKIP.has(word)) continue;
    const stem = stemWord(word);
    const concept = answerConceptTokens(word)[0] || stem;
    if (seen.has(concept)) continue;
    seen.add(concept);
    if (!contextSet.has(concept) && !questionSet.has(concept)) extras.push(word);
  }
  return extras.slice(0, 2);
}

function withExtrasNote(feedback: string, extras: string[]): string {
  if (extras.length === 0) return feedback;
  const quoted = extras.map((word) => `"${word}"`).join(" and ");
  return `${feedback} One thing to double-check: the lesson does not mention ${quoted}.`;
}

// Child's own words whose stems are grounded in the lesson, for naming
// evidence back without hallucinating ("drinking, smelling" from a
// paraphrased correct answer). Skips bare topic words; prefers words that
// match the lesson's fact list so paraphrases surface first ("smelling"
// over "African").
function groundedAnswerWords(
  context: string,
  question: string,
  studentAnswer: string,
  count = 3,
  preferStems: Set<string> = new Set(),
): string[] {
  const relevant = relevantContextTokens(context, question);
  const topic = new Set([...contentTokens(question)].filter((token) => token.length >= 5));
  const seen = new Set<string>();
  const preferred: string[] = [];
  const rest: string[] = [];
  for (const word of String(studentAnswer).match(/[A-Za-z]+/g) || []) {
    if (word.length < 4) continue;
    const stem = stemWord(word.toLowerCase());
    if (seen.has(stem) || topic.has(stem) || !relevant.has(stem)) continue;
    seen.add(stem);
    (preferStems.has(stem) ? preferred : rest).push(word.toLowerCase());
  }
  return [...preferred, ...rest].slice(0, count);
}

function gradeStudentAnswer(
  context: string,
  question: string,
  studentAnswer: string,
  previousAnswers: string[],
  previousAssistant: string[] = [],
  lessonMode = false,
): AnswerGrade {
  // Unanswerable questions come first: when the lesson never mentions what
  // the child asks about ("why don't humans have trunks?"), say so honestly
  // instead of grading the restated question against trunk-use facts. This
  // also affirms a child who correctly notices the lesson is silent.
  const missingEntity = unanswerableEntityFromContext(context, question);
  if (missingEntity) {
    const summary = buildAnswerSummary(context, question);
    if (lessonMode) {
      return {
        responseState: "don't_remember" as const,
        correctness: "partial" as const,
        feedback:
          `You noticed something important — I don't know based on this lesson. ` +
          `This lesson never talks about ${missingEntity}. ${summary}`,
        nextPrompt: GRACEFUL_END_PROMPT,
        graceful: true,
      };
    }
    return {
      responseState: "don't_remember" as const,
      correctness: "partial" as const,
      feedback:
        `You're right to wonder about ${missingEntity}, but I don't know — that is not in the text. ` +
        `The lesson never talks about ${missingEntity}. ${summary}`,
      nextPrompt: GRACEFUL_END_PROMPT,
      graceful: true,
    };
  }

  // Check for uncertainty responses - be flexible about what follows "don't remember/know"
  const hasUncertainty = isUncertainAnswer(studentAnswer);
  const normalizedAnswer = normalizeForComparison(studentAnswer);
  // Match both with and without apostrophes (dont, dont, don't, don.t, etc.)
  const hasDontRemember = /don'?t remember|do not remember|can'?t remember|cannot remember|forgot|don'?t know|do not know/.test(normalizedAnswer);
  
  if (hasDontRemember || hasUncertainty) {
    // Check if there's actual content after the uncertainty disclaimer
    const hasRelevantContent = hasRelevantContextTokens(context, question, studentAnswer);
    
    if (hasRelevantContent) {
      // The child is trying to answer AND acknowledging uncertainty - that's good!
      // Process the content and give encouraging feedback
      const content = extractContentAfterUncertainty(studentAnswer);
      if (content) {
        // Recursively grade the actual content they provided
        return gradeStudentAnswer(context, question, content, previousAnswers);
      }
    }
    
    // Count uncertainty responses from the child's conversation history
    // to avoid looping. Uses a sliding window of the last few answers so
    // a single early "I don't know" doesn't punish the child.
    const recentAnswers = previousAnswers.slice(-3);
    const recentUncertainCount = recentAnswers.filter((ans) => isUncertainAnswer(ans)).length;
    const totalUncertainCount = recentUncertainCount + 1; // +1 for current answer
    
    // After 2 total uncertainty responses, provide a graceful end
    if (totalUncertainCount >= 2) {
      const summary = buildAnswerSummary(context, question);
      return {
        responseState: "don't_remember" as const,
        correctness: "partial" as const,
        feedback: `Great try thinking about it! ${summary}`,
        nextPrompt: "Want to try another question from the lesson?",
      };
    }
    
    return {
      responseState: "don't_remember" as const,
      correctness: "partial" as const,
      feedback: `That is okay. You do not need to remember the exact words. Look for the part about ${pickEvidenceTerm(context, question)} in the lesson to find a clue.`,
      nextPrompt: "What clue can you find in the lesson about this?",
    };
  }

  // Frustrated escalation ("I want the answer", "this does not answer my
  // question"): stop grading and give the graceful grounded summary instead
  // of calling it a misconception.
  if (isExplicitAnswerRequest(studentAnswer)) {
    const summary = buildAnswerSummary(context, question);
    return {
      responseState: "don't_remember" as const,
      correctness: "partial" as const,
      feedback: `That is fair — let me share what the lesson says. ${summary}`,
      nextPrompt: "Want to try another question from the lesson?",
    };
  }

  // Fact-match lookahead: an answer that fully matches a MULTI-word lesson
  // fact ("use them to smell food") is an attempted answer with pronouns,
  // not a topic change — even when it shares no literal word with the
  // question. Single-word matches ("water" in a fish answer) still go
  // through the off-topic check below.
  const earlyFactList = bestFactList(context, question);
  const earlyMultiMatch = earlyFactList.some((item) => {
    const itemTokens = answerConceptTokens(item).filter((token) => !VAGUE_LIST_WORDS.has(token));
    if (itemTokens.length <= 1) return false;
    const answerSet = new Set(answerConceptTokens(studentAnswer));
    return itemTokens.every((token) => answerSet.has(token));
  });

  if (!earlyMultiMatch && isOffTopicAnswer(context, question, studentAnswer)) {
    return {
      responseState: "off_topic" as const,
      correctness: "incorrect" as const,
      feedback: `Good try! That idea is not in the lesson though. The lesson talks about ${pickEvidenceTerm(context, question)} — let's look for what it says.`,
      nextPrompt: "What did the lesson say about your question?",
    };
  }

  const factList = bestFactList(context, question);
  const matched = factList.filter((item) => listItemMatched(studentAnswer, item));
  const answerTokens = contentTokens(studentAnswer);
  const relevantTokens = relevantContextTokens(context, question);
  const supportedTokens = tokenSetOverlap(answerTokens, [...relevantTokens]);
  const allAnswers = previousAnswers.concat(studentAnswer);
  const allMatched = factList.filter((item) => listItemMatched(allAnswers.join(" "), item));

  if (factList.length > 0) {
    // Full-lesson coverage: the fact list only spans the top sentence
    // window, so true facts from other bullets ("pick up grass") share no
    // list item. When 3+ substantive answer words appear ANYWHERE in the
    // lesson, treat it as a useful clue, not a misconception.
    const contextTokenSet = new Set(answerConceptTokens(context));
    const fullSupported = answerConceptTokens(studentAnswer).filter(
      (token) => token.length >= 3 && contextTokenSet.has(token),
    );
    const extras = unsupportedExtras(context, question, studentAnswer);
    const factStems = new Set(factList.flatMap((item) => answerConceptTokens(item)));
    const coveragePartial = (): AnswerGrade | null => {
      if (fullSupported.length < 2 || isGuess(studentAnswer)) return null;
      const { nextPrompt, gracefulSummary } = remainingDetailsOrSummary(context, question, previousAssistant);
      if (gracefulSummary) return gracefulPartialEnd(gracefulSummary);
      let named = groundedAnswerWords(context, question, studentAnswer, 3, factStems);
      if (named.length === 0) {
        // Fall back to the child's own lesson-grounded words (often the
        // topic words themselves) so feedback still names what was right.
        const lessonSet = new Set(answerConceptTokens(context));
        const seen = new Set<string>();
        const fallback: string[] = [];
        for (const word of String(studentAnswer).match(/[A-Za-z]+/g) || []) {
          if (word.length < 4) continue;
          const concept = answerConceptTokens(word)[0];
          if (!concept || seen.has(concept)) continue;
          seen.add(concept);
          if (lessonSet.has(concept)) {
            fallback.push(word.toLowerCase());
            if (fallback.length >= 2) break;
          }
        }
        named = fallback;
      }
      return {
        responseState: "partially_correct" as const,
        correctness: "partial" as const,
        feedback: withExtrasNote(
          named.length > 0
            ? `You found a useful clue from the lesson — ${joinListGrammar(named)}.`
            : "You found a useful clue from the lesson.",
          extras,
        ),
        nextPrompt,
      };
    };

    if (matched.length === 0) {
      // Paraphrased correct answers ("breathing, smelling, drinking" for a
      // trunk-uses list) share no full list item but cover the lesson in
      // their own words. Recognize strong token coverage as correct while
      // tolerating at most one unmatched word (a synonym like "grasping").
      // Two or more invented extras ("play games") stay partial.
      if (
        !isGuess(studentAnswer) &&
        answerTokens.length > 5 &&
        supportedTokens.length >= Math.max(4, Math.ceil(answerTokens.length * 0.5)) &&
        extras.length <= 1
      ) {
        const named = groundedAnswerWords(context, question, studentAnswer, 3, factStems);
        return {
          responseState: hasReasoning(studentAnswer) ? "correct_and_explained" as const : "correct_but_no_reasoning" as const,
          correctness: "correct" as const,
          feedback: hasReasoning(studentAnswer)
            ? `Exactly. You found details like ${joinListGrammar(named)} from the lesson and explained them in your own words.`
            : `Exactly. You found details like ${joinListGrammar(named)} from the lesson. How do you know?`,
          nextPrompt: hasReasoning(studentAnswer) ? "Can you explain it another way?" : "How do you know?",
        };
      }
      if (supportedTokens.length === 0) {
        // True lesson facts outside the top-window fact list still deserve
        // partial credit rather than a misconception label.
        const coverage = coveragePartial();
        if (coverage) return coverage;
        return {
          responseState: isGuess(studentAnswer) ? "guessing" as const : "misconception" as const,
          correctness: "incorrect" as const,
          feedback: isGuess(studentAnswer)
            ? "A guess is a useful start. What makes you think that? Look for a lesson detail to support your idea."
            : `Let's test that idea against the lesson. Look at what it says about ${pickEvidenceTerm(context, question)}.`,
          nextPrompt: "What detail from the lesson supports your thinking?",
        };
      }

      const supportedFactItems = factList.filter((item) => {
        const itemTokens = answerConceptTokens(item).filter((token) => !VAGUE_LIST_WORDS.has(token));
        const normalizedAnswerTokens = new Set(answerConceptTokens(studentAnswer));
        const shared = itemTokens.filter((token) => normalizedAnswerTokens.has(token));
        // A single repeated word ("trunk") is not evidence of recall. Require
        // at least two shared substantive tokens, or the whole item when the
        // item itself is a single substantive token ("water").
        if (itemTokens.length <= 1) return shared.length >= 1;
        return shared.length >= 2;
      });

      if (supportedFactItems.length > 0) {
        const { nextPrompt, gracefulSummary } = remainingDetailsOrSummary(context, question, previousAssistant);
        if (gracefulSummary) return gracefulPartialEnd(gracefulSummary);
        return {
          responseState: "partially_correct" as const,
          correctness: "partial" as const,
          feedback: withExtrasNote(
            `Good memory — I see "${supportedFactItems[0]}" from the lesson in your answer.`,
            extras,
          ),
          nextPrompt,
        };
      }

      // No list item matched, but broad lesson coverage still earns a
      // useful-clue partial instead of a misconception label.
      const coverage = coveragePartial();
      if (coverage) return coverage;

      return {
        responseState: "misconception" as const,
        correctness: "incorrect" as const,
        feedback: `That answer does not match the lesson yet. Look at what the lesson says about ${pickEvidenceTerm(context, question)}.`,
        nextPrompt: "What detail from the lesson can help us?",
      };
    }

    const complete = allMatched.length === factList.length || (factList.length >= 3 && allMatched.length >= 3);

    if (complete) {
      const named = joinListGrammar(allMatched.slice(0, 4));
      return {
        responseState: hasReasoning(studentAnswer) ? "correct_and_explained" as const : "correct_but_no_reasoning" as const,
        correctness: "correct" as const,
        feedback: hasReasoning(studentAnswer)
          ? `Exactly. You named ${named} and explained them in your own words.`
          : `Exactly. You named ${named}.`,
        nextPrompt: hasReasoning(studentAnswer) ? "Can you explain it another way?" : "How do you know?",
      };
    }

    // Very short answers that nail a fact item ("Water.") are correct, not
    // partial — invite the evidence next. Counts real words, so a full
    // sentence like "Plants need water." still earns its partial step.
    if (String(studentAnswer).trim().split(/\s+/).length <= 2) {
      const named = joinListGrammar(matched.slice(0, 2));
      return {
        responseState: "correct_but_no_reasoning" as const,
        correctness: "correct" as const,
        feedback: `Exactly. You named ${named}.`,
        nextPrompt: "How do you know?",
      };
    }

    const { nextPrompt, gracefulSummary } = remainingDetailsOrSummary(context, question, previousAssistant);
    if (gracefulSummary) return gracefulPartialEnd(gracefulSummary);

    return {
      responseState: "partially_correct" as const,
      correctness: "partial" as const,
      feedback: withExtrasNote(
        `Good memory. You named ${joinListGrammar(matched.slice(0, 3))} from the lesson.`,
        unsupportedExtras(context, question, studentAnswer),
      ),
      nextPrompt,
    };
  }

  if (supportedTokens.length === 0) {
    return {
      responseState: isGuess(studentAnswer) ? "guessing" as const : "misconception" as const,
      correctness: "incorrect" as const,
      feedback: isGuess(studentAnswer)
        ? "A guess is a useful start. What makes you think that? Look for a lesson detail to support your idea."
        : "Let's test that idea against the lesson. Which detail supports your thinking?",
      nextPrompt: "What makes you think that?",
    };
  }

  if (answerTokens.length <= 2 || supportedTokens.length >= Math.max(2, Math.ceil(answerTokens.length * 0.5))) {
    return {
      responseState: hasReasoning(studentAnswer) ? "correct_and_explained" as const : "correct_but_no_reasoning" as const,
      correctness: "correct" as const,
      feedback: hasReasoning(studentAnswer)
        ? "Exactly. You explained the answer using evidence in your own words."
        : "Yes, that idea is supported by the lesson. How do you know?",
      nextPrompt: hasReasoning(studentAnswer) ? "Can you explain it another way?" : "How do you know?",
    };
  }

  return {
    responseState: "partially_correct" as const,
    correctness: "partial" as const,
    feedback: "You used a detail from the lesson. Add one more detail and explain how it connects to the question, using your own words.",
    nextPrompt: "What other detail from the lesson could make your answer stronger?",
  };
}

function gradeExplanation(
  context: string,
  question: string,
  studentAnswer: string,
  explanation: string
) {
  const clue = pickEvidenceTerm(context, question);
  const overlap = tokenSetOverlap(contentTokens(explanation), contentTokens(context));
  const citesLesson = /\b(lesson|sentence|says|said|because)\b/i.test(explanation);

  if (isUncertainAnswer(explanation)) {
    return {
      score: 40,
      feedback: `That is okay. You do not need to remember the exact words. Look back at the lesson and describe one detail about ${clue} in your own words.`,
      finalPrompt: "Which lesson detail helped you decide?",
      retry: true,
    };
  }

  if (overlap.length === 0) {
    return {
      score: 25,
      feedback: `Your explanation does not use a clue from the lesson yet. Look at what the lesson says about ${clue}.`,
      finalPrompt: "Which lesson detail helped you decide?",
    };
  }

  const score = overlap.length >= 2 && citesLesson ? 80 : overlap.length >= 1 && citesLesson ? 70 : overlap.length >= 2 ? 65 : 45;

  // Name the grounded words back so the child sees WHICH evidence landed
  // (and so the response carries grounding signals, not generic praise).
  // Numbers count as evidence ("68"); filler words never do ("that").
  const EVIDENCE_WORD_SKIP = new Set([
    "that", "this", "these", "those", "with", "from", "have", "has", "had",
    "were", "was", "are", "when", "where", "which", "who", "there", "their",
    "them", "then", "than", "such", "some", "other", "same", "into", "over",
    "about", "before", "after", "while", "both", "each", "more", "most",
    "only", "very", "just", "also", "even", "still",
  ]);
  const seenOverlap = new Set<string>();
  const evidenceWords: string[] = [];
  for (const word of String(explanation).match(/[A-Za-z0-9]+/g) || []) {
    const lower = word.toLowerCase();
    if (lower.length < 2 || EVIDENCE_WORD_SKIP.has(lower)) continue;
    const stem = stemWord(lower);
    if (seenOverlap.has(stem)) continue;
    seenOverlap.add(stem);
    if (contentTokens(word).some((token) => overlap.includes(token))) {
      evidenceWords.push(lower);
      if (evidenceWords.length >= 3) break;
    }
  }

  return {
    score,
    feedback: evidenceWords.length > 0
      ? `You used evidence from the lesson — ${evidenceWords.join(", ")} — to explain your thinking. To make it stronger, say what the lesson tells us about ${clue}.`
      : `You shared an idea. Point to one detail from the lesson about ${clue} to support it.`,
    finalPrompt: "Which lesson detail helped you decide?",
  };
}

function buildFallbackResponse(
  mode: string,
  studentAnswer: string,
  questionType: string,
  context = "",
  question = ""
) {
  const normalized = studentAnswer.toLowerCase();

  if (mode === "answer") {
    if (normalized.includes("don't know") || normalized.includes("dont know") || normalized.includes("not sure")) {
      return {
        type: "evaluation",
        correctness: "partial",
          feedback: `That is okay. Look back at the lesson and describe one detail about ${pickEvidenceTerm(context, question) || "this"} in your own words.`,
        nextPrompt: "How did you know?",
        hintLevel: 2,
      };
    }

    return {
      type: "evaluation",
      correctness: "partial",
        feedback: "You shared an idea. Try to add one detail from the lesson to make your answer stronger.",
      nextPrompt: "How did you know?",
      hintLevel: 2,
    };
  }

  if (mode === "explanation") {
    if (normalized.includes("don't know") || normalized.includes("dont know") || normalized.includes("not sure")) {
      return {
        type: "explanationFeedback",
        score: 40,
          feedback: `You can explain your thinking with one detail from the lesson about ${pickEvidenceTerm(context, question) || "this"}, using your own words.`,
        finalPrompt: "Which lesson detail helped you decide?",
          retry: true,
      };
    }

    return {
      type: "explanationFeedback",
      score: 50,
        feedback: "Your explanation is on the right track. Add one clear detail from the lesson.",
      finalPrompt: "Which lesson detail helped you decide?",
    };
  }

  return {
    type: "guidingQuestion",
    question: context
      ? buildContextGuidingQuestion(context, question, questionType === "creative" ? "creative" : "guided")
      : "What do you notice first in the lesson?",
    hintLevel: 1,
    questionType,
  };
}

function buildGuidingPrompt(
  context: string,
  question: string,
  age: number,
  questionType: "guided" | "creative",
  hintLevel: number
) {
  const creativeInstruction =
    questionType === "creative"
      ? "Make the guiding question ask the child to invent their own example using the context."
      : "Make the guiding question help the child think without answering directly.";

  return `You are a Socratic teaching assistant for a ${age}-year-old child.

Use ONLY the context below.
Respond in simple, clear English only.
Do NOT state the answer.
Do NOT invent new facts.
Do not provide a full explanation.
Do not repeat the user's question.
Do not ask a yes/no question.
Ask the child to notice, compare, or look for a clue in the lesson.
If the child says \"just tell me\", respond with an easier question.
Keep the guiding question short and friendly.
Name one concrete word from the context in the question.
${creativeInstruction}
${OCR_MARKER_GUARD}


CONTEXT:
${context}

QUESTION:
${question}

Return ONLY valid JSON with this exact structure and no code fences.
{
  "type": "guidingQuestion",
  "question": "...",
  "hintLevel": ${hintLevel},
  "questionType": "${questionType}"
}
`;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  const body = (await req.json()) as AskRequest;
  const question = (body.question || "").trim();
  const age = body.age ?? 8;
  const mode = body.mode || "question";
  const questionType = body.questionType || "guided";
  const studentAnswer = (body.studentAnswer || "").trim();
  const explanation = (body.explanation || "").trim();

  if (mode === "question" && !question) {
    return NextResponse.json({ error: "A question is required." }, { status: 400 });
  }

  if (mode === "answer" && !studentAnswer) {
    return NextResponse.json({ error: "An answer is required." }, { status: 400 });
  }

  if (mode === "explanation" && !explanation) {
    return NextResponse.json({ error: "An explanation is required." }, { status: 400 });
  }

  const retrievalStart = Date.now();
  // Lesson-linked Ask: the DISPLAYED lesson is the only grounding context.
  // Retrieval is skipped entirely so untaught document facts can never leak
  // into clues, feedback, or summaries. Standalone mode is unchanged.
  const lessonMode = body.source === "lesson";
  const lessonText =
    typeof body.lessonText === "string" ? body.lessonText.trim().slice(0, 2000) : "";
  let context: string;
  let retrievalTime: number;
  if (lessonMode) {
    context = lessonText;
    retrievalTime = Date.now() - retrievalStart;
    console.log(`[ask] lesson mode, lessonText length: ${lessonText.length}`);
  } else {
    context = await getRelevantContext(cleanRetrievalQuery(question || studentAnswer || explanation));
    retrievalTime = Date.now() - retrievalStart;
  }

  if (!context || context.trim().length === 0) {
    const totalTime = Date.now() - startTime;
    if (lessonMode) {
      // Lesson-linked but nothing to ground on: be honest in the schema the
      // caller expects, without retrieving document facts to fill the gap.
      const honest = "I don't know based on this lesson. Please open the lesson first, then ask about what it teaches.";
      if (mode === "answer") {
        return NextResponse.json(withConversation(body, [honest], {
          type: "evaluation",
          responseState: "don't_remember" as const,
          correctness: "partial" as const,
          feedback: honest,
          nextPrompt: GRACEFUL_END_PROMPT,
          continueLearning: false,
          hintLevel: 3,
          source: "Document",
          _timing: { totalTime, retrievalTime },
        }), { status: 200 });
      }
      if (mode === "explanation") {
        return NextResponse.json(withConversation(body, [honest], {
          type: "explanationFeedback",
          score: 0,
          feedback: honest,
          finalPrompt: "What does your lesson teach?",
          source: "Document",
          _timing: { totalTime, retrievalTime },
        }), { status: 200 });
      }
      return NextResponse.json(
        withConversation(body, [honest], {
          answer: honest,
          source: "Document",
          _timing: { totalTime, retrievalTime },
        }),
        { status: 200 }
      );
    }
    return NextResponse.json(
      withConversation(body, ["I don't know. Please ask a parent to add more information."], {
        answer: "I don't know. Please ask a parent to add more information.",
        source: "Document",
        _timing: { totalTime, retrievalTime },
      }),
      { status: 200 }
    );
  }

  // Honest handling for questions the lesson cannot answer ("why don't
  // humans have trunks?"). Without this gate the flow asks the child to hunt
  // for trunk-use clues to a question the lesson never addresses, which is
  // what frustrated the trunk conversation.
  if (mode === "question") {
    // Lesson-linked: anything beyond the displayed lesson's own words is
    // honestly unknown. Never reach into the document for more.
    if (lessonMode && !questionCoveredByLesson(context, question)) {
      const totalTime = Date.now() - startTime;
      const summary = buildAnswerSummary(context, question);
      const honest =
        `I don't know based on this lesson. ` +
        `${summary} Want to explore what the lesson does say?`;
      return NextResponse.json(
        withConversation(body, [honest], {
          answer: honest,
          source: "Document",
          _timing: { totalTime, retrievalTime },
        }),
        { status: 200 },
      );
    }
    const missingEntity = unanswerableEntityFromContext(context, question);
    if (missingEntity) {
      const totalTime = Date.now() - startTime;
      const summary = buildAnswerSummary(context, question);
      const honest =
        `I don't know about ${missingEntity} — that is not in the text. ` +
        `${summary} Want to explore what the lesson does say?`;
      return NextResponse.json(
        withConversation(body, [honest], {
          answer: honest,
          source: "Document",
          _timing: { totalTime, retrievalTime },
        }),
        { status: 200 },
      );
    }
  }

  if (mode === "answer") {
    const previousAnswers = Array.isArray(body.conversation)
      ? body.conversation.filter((turn) => turn.role === "child").map((turn) => turn.content)
      : [];
    const previousAssistant = Array.isArray(body.conversation)
      ? body.conversation.filter((turn) => turn.role === "assistant").map((turn) => turn.content)
      : [];
    
    console.log(`[answer] question: "${question}" context preview: "${context.substring(0, 100)}..."`);
    
    if (!contextMatchesQuestion(context, question)) {
      console.log("[answer] Context does not match question, rejecting");
      const totalTime = Date.now() - startTime;
      return NextResponse.json(withConversation(body, ["Let me find better information about your question. Please ask it again and I'll help."], {
        type: "evaluation",
        responseState: "off_topic" as const,
        correctness: "incorrect" as const,
        feedback: "Let me find better information about your question. Please ask again.",
        nextPrompt: "What is your question about?",
        continueLearning: false,
        hintLevel: 1,
        source: "Document",
        _timing: { totalTime, retrievalTime },
      }), { status: 200 });
    }
    
    const graded = gradeStudentAnswer(context, question, studentAnswer, previousAnswers, previousAssistant, lessonMode);
    const totalTime = Date.now() - startTime;
    // Don't keep the conversation going if the child is unable to recall content
    // after multiple attempts, or if the child is correct.
    const recentAnswers = previousAnswers.slice(-3);
    const recentUncertainCount = recentAnswers.filter((ans) => isUncertainAnswer(ans)).length;
    const totalUncertain = recentUncertainCount + 1;
    const shouldEnd =
      graded.responseState === "correct_and_explained" ||
      graded.responseState === "correct_but_no_reasoning" ||
      graded.graceful === true ||
      (graded.responseState === "don't_remember" && totalUncertain >= 2) ||
      // Explicit "just tell me" escalation already received the summary.
      (graded.responseState === "don't_remember" && isExplicitAnswerRequest(studentAnswer));
    const continueLearning = !shouldEnd;
    return NextResponse.json(withConversation(body, [`${graded.feedback}\n\n${graded.nextPrompt}`], {
      type: "evaluation",
      responseState: graded.responseState,
      correctness: graded.correctness,
      feedback: graded.feedback,
      nextPrompt: graded.nextPrompt,
      continueLearning,
      hintLevel: continueLearning ? 2 : 3,
      source: "Document",
      _timing: { totalTime, retrievalTime },
    }));
  }

  if (mode === "explanation") {
    if (!contextMatchesQuestion(context, question)) {
      const totalTime = Date.now() - startTime;
      return NextResponse.json(withConversation(body, ["Let me find better information about your question. Please ask it again and I'll help."], {
        type: "explanationFeedback",
        score: 0,
        feedback: "Let me find better information about your question. Please ask again.",
        finalPrompt: "What is your question about?",
        source: "Document",
        _timing: { totalTime, retrievalTime },
      }), { status: 200 });
    }
    
    const graded = gradeExplanation(context, question, studentAnswer, explanation);
    const totalTime = Date.now() - startTime;
    return NextResponse.json(withConversation(body, [`${graded.feedback}\n\n${graded.finalPrompt}`], {
      type: "explanationFeedback",
      score: graded.score,
      feedback: graded.feedback,
      finalPrompt: graded.finalPrompt,
      retry: "retry" in graded && graded.retry === true,
      source: "Document",
      _timing: { totalTime, retrievalTime },
    }));
  }

  if (isDirectAnswerRequest(question)) {
    const totalTime = Date.now() - startTime;
    return NextResponse.json(withConversation(body, [buildContextGuidingQuestion(context, question, questionType)], {
      type: "guidingQuestion",
      question: buildContextGuidingQuestion(context, question, questionType),
      hintLevel: 1,
      questionType,
      source: "Document",
      _timing: { totalTime, retrievalTime },
    }));
  }

  const prompt = buildGuidingPrompt(context, question, age, questionType, 1);

  const llmStart = Date.now();
  let rawResponse: string;
  try {
    rawResponse = await generateAnswer(prompt, 120);
  } catch (error) {
    console.error("[ask] LLM error:", error);
    return NextResponse.json({ error: "Failed to generate a response." }, { status: 500 });
  }
  const llmTime = Date.now() - llmStart;

  const parsed = sanitizeJson(rawResponse);
  const fallback = buildFallbackResponse(mode, studentAnswer || explanation, questionType, context, question);
  const totalTime = Date.now() - startTime;
  const timing = { totalTime, retrievalTime, llmTime };
  const contextAwareQuestion = buildContextGuidingQuestion(context, question, questionType);
  const evidenceTerm = pickEvidenceTerm(context, question);

  if (!parsed) {
    console.warn("[ask] Falling back to friendly response for non-JSON output", rawResponse);
    const extractedQuestion = extractField(rawResponse, "question") || extractField(rawResponse, "Question");
    const extractedUsable =
      extractedQuestion &&
      looksLikeEnglishText(extractedQuestion) &&
      !isTooSimilarToOriginal(extractedQuestion, question) &&
      !isMalformedGuidingQuestion(extractedQuestion) &&
      contentTokens(extractedQuestion).includes(evidenceTerm);

    return NextResponse.json(withConversation(body, [extractedUsable ? extractedQuestion : contextAwareQuestion], {
      type: fallback.type,
      question: extractedUsable ? extractedQuestion : contextAwareQuestion,
      hintLevel: fallback.hintLevel,
      questionType: fallback.questionType,
      source: "Document",
      _timing: timing,
    }));
  }

  const questionText = parsed.question && looksLikeEnglishText(parsed.question) ? parsed.question : null;
  const modelQuestionUsable =
    questionText &&
    !isTooSimilarToOriginal(questionText, question) &&
    !isMalformedGuidingQuestion(questionText) &&
    contentTokens(questionText).includes(evidenceTerm);

  return NextResponse.json(withConversation(body, [modelQuestionUsable ? questionText : contextAwareQuestion], {
    type: normalizeResponseType(mode, parsed.type),
    question: modelQuestionUsable ? questionText : contextAwareQuestion,
    hintLevel: parsed.hintLevel || fallback.hintLevel,
    questionType: normalizeQuestionType(parsed.questionType, questionType),
    source: "Document",
    _timing: timing
  }));
}
