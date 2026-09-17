import { NextResponse } from "next/server";
import { generateAnswer } from "@/lib/ai";
import { cleanRetrievalQuery, contentTokens, getRelevantContext } from "@/lib/retrieval";
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

const VAGUE_LIST_WORDS = new Set([
  "several", "thing", "things", "well", "different", "job", "jobs", "way", "ways",
  "rest", "own", "help", "helps", "also",
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
        .map((part) => part.replace(/[^a-zA-Z0-9\s]/g, " ").trim())
        .filter((part) => {
          const tokens = contentTokens(part).filter((token) => !VAGUE_LIST_WORDS.has(token));
          return tokens.length > 0;
        });
      if (parts.length > 0) lists.push(parts);
    }
  }

  return lists;
}

function listItemMatched(studentAnswer: string, item: string) {
  const answerTokens = new Set(contentTokens(studentAnswer));
  const itemTokens = contentTokens(item).filter((token) => !VAGUE_LIST_WORDS.has(token));
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

  for (const item of ranked) {
    if (item.overlap === 0) continue;
    const window = sentences.slice(item.index, item.index + 2).join(" ");
    const list = pickLongest(window);
    if (list.length > 0) return list;
  }

  return pickLongest(context);
}

function pickClueTerm(context: string, question: string) {
  const questionTokens = contentTokens(question);
  const contextTokenList = contentTokens(context);
  const shared = questionTokens.find((token) => contextTokenList.includes(token));
  if (shared) return shared;

  const fact = bestFactList(context, question)[0];
  if (fact) {
    const token = contentTokens(fact)[0];
    if (token) return token;
  }

  return contextTokenList[0] || "this";
}

function pickEvidenceTerm(context: string, question: string) {
  const fact = bestFactList(context, question)[0];
  if (fact) {
    const token = contentTokens(fact).find((item) => item.length > 2);
    if (token) return token;
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
    return `Invent your own example about ${topic} that uses a clue like ${evidence} from the lesson.`;
  }

  if (topic === evidence) {
    return `What did the lesson say about ${topic}?`;
  }

  return `What did the lesson say about ${topic} and ${evidence}?`;
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
function buildAnswerSummary(context: string, question: string): string {
  // Build a summary of the key points from the context to help the child
  const factList = bestFactList(context, question);
  
  if (factList.length > 0) {
    const formatted = factList.slice(0, 4).join(", ");
    return `Plants mainly need things like ${formatted}.`;
  }
  
  // Fallback: extract key tokens from the question and context
  const keyTokens = relevantContextTokens(context, question);
  const keyWords = Array.from(keyTokens).slice(0, 5);
  
  if (keyWords.length > 0) {
    return `From the lesson, ${keyWords.join(", ")} are important for this topic.`;
  }
  
  return "Keep exploring the lesson to discover more!";
}



function gradeStudentAnswer(context: string, question: string, studentAnswer: string, previousAnswers: string[]): AnswerGrade {
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
      feedback: "That is okay. You do not need to remember the exact words. Let's use a clue from the lesson to find the answer together.",
      nextPrompt: "What clue can you find in the lesson about this?",
    };
  }

  if (isOffTopicAnswer(context, question, studentAnswer)) {
    return {
      responseState: "off_topic" as const,
      correctness: "incorrect" as const,
      feedback: "That idea is not what the lesson is about. Let's look for the right information.",
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
    if (matched.length === 0 && supportedTokens.length === 0) {
      return {
        responseState: isGuess(studentAnswer) ? "guessing" as const : "misconception" as const,
        correctness: "incorrect" as const,
        feedback: isGuess(studentAnswer)
          ? "A guess is a useful start. What makes you think that? Look for a lesson detail to support your idea."
          : "Let's test that idea against the lesson. What does the lesson say?",
        nextPrompt: "What detail from the lesson supports your thinking?",
      };
    }

    if (matched.length === 0) {
      return {
        responseState: "misconception" as const,
        correctness: "incorrect" as const,
        feedback: "That answer does not match the lesson yet. Let's look at what the lesson says.",
        nextPrompt: "What detail from the lesson can help us?",
      };
    }

    const complete = allMatched.length === factList.length || (factList.length >= 3 && allMatched.length >= 3);

    if (complete) {
      return {
        responseState: hasReasoning(studentAnswer) ? "correct_and_explained" as const : "correct_but_no_reasoning" as const,
        correctness: "correct" as const,
        feedback: hasReasoning(studentAnswer)
          ? "Exactly. You found the important uses and explained them in your own words."
          : "Exactly. You found the important uses. How do you know?",
        nextPrompt: hasReasoning(studentAnswer) ? "Can you explain it another way?" : "How do you know?",
      };
    }

    return {
      responseState: "partially_correct" as const,
      correctness: "partial" as const,
      feedback: matched.length > 0 ? "Good memory. That is one thing the lesson said." : "You found a useful clue.",
      nextPrompt: `What else did the lesson say about ${allMatched[allMatched.length - 1] || "that"}?`,
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

  return {
    score,
    feedback: "You used evidence from the lesson to explain your thinking.",
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
  const context = await getRelevantContext(cleanRetrievalQuery(question || studentAnswer || explanation));
  const retrievalTime = Date.now() - retrievalStart;

  if (!context || context.trim().length === 0) {
    const totalTime = Date.now() - startTime;
    return NextResponse.json(
      withConversation(body, ["I don't know. Please ask a parent to add more information."], {
        answer: "I don't know. Please ask a parent to add more information.",
        source: "Document",
        _timing: { totalTime, retrievalTime },
      }),
      { status: 200 }
    );
  }

  if (mode === "answer") {
    const previousAnswers = Array.isArray(body.conversation)
      ? body.conversation.filter((turn) => turn.role === "child").map((turn) => turn.content)
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
    
    const graded = gradeStudentAnswer(context, question, studentAnswer, previousAnswers);
    const totalTime = Date.now() - startTime;
    // Don't keep the conversation going if the child is unable to recall content
    // after multiple attempts, or if the child is correct.
    const recentAnswers = previousAnswers.slice(-3);
    const recentUncertainCount = recentAnswers.filter((ans) => isUncertainAnswer(ans)).length;
    const totalUncertain = recentUncertainCount + 1;
    const shouldEnd = 
      graded.responseState === "correct_and_explained" ||
      graded.responseState === "correct_but_no_reasoning" ||
      (graded.responseState === "don't_remember" && totalUncertain >= 2);
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
