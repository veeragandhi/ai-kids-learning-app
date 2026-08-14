import { NextResponse } from "next/server";
import { generateAnswer } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

type AskRequest = {
  question?: string;
  age?: number;
  mode?: "question" | "answer" | "explanation";
  questionType?: "guided" | "creative";
  studentAnswer?: string;
  explanation?: string;
  guidingQuestion?: string;
};

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

function isTooSimilarToOriginal(generatedQuestion: string, originalQuestion: string) {
  const generated = normalizeForComparison(generatedQuestion);
  const original = normalizeForComparison(originalQuestion);

  if (!generated || !original) return false;
  if (generated === original) return true;
  if (generated.includes(original) || original.includes(generated)) return true;

  const generatedTokens = generated.split(/\s+/);
  const originalTokens = original.split(/\s+/);
  const overlap = generatedTokens.filter((token) => originalTokens.includes(token)).length;
  const similarity = overlap / Math.max(originalTokens.length, 1);
  const startsWithYesNoWord = /^(can|could|do|does|did|is|are|was|were|will|would)\b/.test(generated);

  return similarity >= 0.5 || (startsWithYesNoWord && generatedTokens.length <= 8);
}

function buildDefaultGuidingQuestion(originalQuestion: string) {
  if (originalQuestion?.trim()) {
    return "What clue in the text helps you answer this question?";
  }

  return "What do you notice first in the text?";
}

function buildFallbackResponse(mode: string, studentAnswer: string, questionType: string) {
  const normalized = studentAnswer.toLowerCase();

  if (mode === "answer") {
    if (normalized.includes("don't know") || normalized.includes("dont know") || normalized.includes("not sure")) {
      return {
        type: "evaluation",
        correctness: "partial",
        feedback: "That is okay. Try to use one clue from the text and tell us what you noticed.",
        nextPrompt: "How did you know?",
        hintLevel: 2,
      };
    }

    return {
      type: "evaluation",
      correctness: "partial",
      feedback: "You shared an idea. Try to add one detail from the text to make your answer stronger.",
      nextPrompt: "How did you know?",
      hintLevel: 2,
    };
  }

  if (mode === "explanation") {
    if (normalized.includes("don't know") || normalized.includes("dont know") || normalized.includes("not sure")) {
      return {
        type: "explanationFeedback",
        score: 50,
        feedback: "You can explain your thinking with one clue from the text.",
        finalPrompt: "What part of the text helped you decide?",
      };
    }

    return {
      type: "explanationFeedback",
      score: 50,
      feedback: "Your explanation is on the right track. Add one clear detail from the text.",
      finalPrompt: "What evidence from the text helped you decide?",
    };
  }

  return {
    type: "guidingQuestion",
    question: "What do you notice first in the text?",
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
Ask the child to notice, compare, or look for a clue in the text.
If the child says \"just tell me\", respond with an easier question.
Keep the guiding question short and friendly.
${creativeInstruction}

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

function buildAnswerPrompt(
  context: string,
  question: string,
  guidingQuestion: string,
  studentAnswer: string,
  age: number
) {
  return `You are grading a student's answer to a guiding question for a ${age}-year-old child.
Use ONLY the context below.
Respond in simple, clear English only.
Decide if the student's answer is correct, partially correct, or incorrect based on the context.
Always provide one short, kind piece of feedback.
Then ask the next prompt exactly as: How did you know?

CONTEXT:
${context}

ORIGINAL QUESTION:
${question}

GUIDING QUESTION:
${guidingQuestion}

STUDENT ANSWER:
${studentAnswer}

Return ONLY valid JSON with this exact structure and no code fences.
{
  "type": "evaluation",
  "correctness": "correct",
  "feedback": "...",
  "nextPrompt": "How did you know?",
  "hintLevel": 2
}
`;
}

function buildExplanationPrompt(
  context: string,
  question: string,
  guidingQuestion: string,
  studentAnswer: string,
  explanation: string
) {
  return `You are grading a student's explanation for how they knew their answer.
Use ONLY the context below.
Respond in simple, clear English only.
Score the explanation on a 0-100 rubric based on evidence from the context, clarity of reasoning, and whether the explanation answers how the child arrived at the answer.
Do NOT guess the actual answer if the explanation is unclear.

CONTEXT:
${context}

ORIGINAL QUESTION:
${question}

GUIDING QUESTION:
${guidingQuestion}

STUDENT ANSWER:
${studentAnswer}

EXPLANATION:
${explanation}

Return ONLY valid JSON with this exact structure and no code fences.
{
  "type": "explanationFeedback",
  "score": 0,
  "feedback": "...",
  "finalPrompt": "..."
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
  const guidingQuestion = (body.guidingQuestion || "").trim();

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
  const context = await getRelevantContext(question || studentAnswer || explanation);
  const retrievalTime = Date.now() - retrievalStart;

  if (!context || context.trim().length === 0) {
    const totalTime = Date.now() - startTime;
    return NextResponse.json(
      {
        answer: "I don't know. Please ask a parent to add more information.",
        source: "Document",
        _timing: { totalTime, retrievalTime }
      },
      { status: 200 }
    );
  }

  let prompt: string;
  if (mode === "answer") {
    prompt = buildAnswerPrompt(context, question, guidingQuestion, studentAnswer, age);
  } else if (mode === "explanation") {
    prompt = buildExplanationPrompt(context, question, guidingQuestion, studentAnswer, explanation);
  } else {
    prompt = buildGuidingPrompt(context, question, age, questionType, 1);
  }

  const llmStart = Date.now();
  let rawResponse: string;
  try {
    rawResponse = await generateAnswer(prompt, 60);
  } catch (error) {
    console.error("[ask] LLM error:", error);
    return NextResponse.json({ error: "Failed to generate a response." }, { status: 500 });
  }
  const llmTime = Date.now() - llmStart;

  const parsed = sanitizeJson(rawResponse);
  const fallback = buildFallbackResponse(mode, studentAnswer, questionType);
  const totalTime = Date.now() - startTime;
  const timing = { totalTime, retrievalTime, llmTime };

  if (!parsed) {
    console.warn("[ask] Falling back to friendly response for non-JSON output", rawResponse);
    const extractedQuestion = extractField(rawResponse, "question") || extractField(rawResponse, "Question");

    if (mode === "answer") {
      return NextResponse.json({
        type: fallback.type,
        correctness: fallback.correctness,
        feedback: fallback.feedback,
        nextPrompt: fallback.nextPrompt,
        hintLevel: fallback.hintLevel,
        source: "Document",
        _timing: timing,
      });
    }

    if (mode === "explanation") {
      return NextResponse.json({
        type: fallback.type,
        score: fallback.score,
        feedback: fallback.feedback,
        finalPrompt: fallback.finalPrompt,
        source: "Document",
        _timing: timing,
      });
    }

    return NextResponse.json({
      type: fallback.type,
      question: extractedQuestion || fallback.question,
      hintLevel: fallback.hintLevel,
      questionType: fallback.questionType,
      source: "Document",
      _timing: timing,
    });
  }

  const questionText = parsed.question && looksLikeEnglishText(parsed.question) ? parsed.question : null;
  const feedbackText = parsed.feedback && looksLikeEnglishText(parsed.feedback) ? parsed.feedback : null;
  const finalPromptText = parsed.finalPrompt && looksLikeEnglishText(parsed.finalPrompt) ? parsed.finalPrompt : null;
  const safeQuestion = questionText && !isTooSimilarToOriginal(questionText, question)
    ? questionText
    : buildDefaultGuidingQuestion(question);

  if (mode === "answer") {
    return NextResponse.json({
      type: normalizeResponseType(mode, parsed.type),
      correctness: parsed.correctness,
      feedback: feedbackText || fallback.feedback,
      nextPrompt: parsed.nextPrompt || fallback.nextPrompt,
      hintLevel: parsed.hintLevel || fallback.hintLevel,
      source: "Document",
      _timing: timing
    });
  }

  if (mode === "explanation") {
    return NextResponse.json({
      type: normalizeResponseType(mode, parsed.type),
      score: Number(parsed.score) || fallback.score,
      feedback: feedbackText || fallback.feedback,
      finalPrompt: finalPromptText || fallback.finalPrompt,
      source: "Document",
      _timing: timing
    });
  }

  return NextResponse.json({
    type: normalizeResponseType(mode, parsed.type),
    question: safeQuestion || fallback.question,
    hintLevel: parsed.hintLevel || fallback.hintLevel,
    questionType: parsed.questionType || fallback.questionType,
    source: "Document",
    _timing: timing
  });
}
