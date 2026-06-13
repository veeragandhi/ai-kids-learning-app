import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

function buildQuizPrompt(
  context: string,
  topic: string,
  age: number
) {
  return `
You are a fun teacher for a ${age}-year-old child.

Using ONLY the context below,
create 3 easy quiz questions.

CRITICAL RULES - YOU MUST FOLLOW THESE:
1. Use simple language
2. Each question must have 3 options
3. Include the correct answer
4. Do NOT invent facts or add information not in the context
5. Do NOT make up questions about topics not in the context
6. If the context is empty or insufficient, respond with ONLY:
   []

Do NOT include other text. Return ONLY valid JSON array.

Example:

[
  {
    "question": "What do plants need?",
    "options": [
      "Sunlight",
      "Pizza",
      "Cars"
    ],
    "answer": "Sunlight"
  }
]

Context:
${context}

Topic:
${topic}

If context does not contain sufficient information to create questions, return ONLY:
[]

Otherwise, return ONLY the JSON array (no other text, no preamble).
`;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  console.log("[quiz] POST request started");
  
  // Check if streaming is requested
  const url = new URL(req.url);
  const stream = url.searchParams.get("stream") === "true";
  
  const body = await req.json();
  const { topic, age = 5 } = body;

  const retrievalStart = Date.now();
  const context = await getRelevantContext(topic);
  const retrievalTime = Date.now() - retrievalStart;
  console.log(`[quiz] RAG retrieval took ${retrievalTime}ms`);
  
  if (!context || context.trim().length === 0) {
    console.log(`[quiz] No context found, total time: ${Date.now() - startTime}ms`);
    return NextResponse.json({
      quiz: "I don't know. Please ask a parent to add more information."
    });
  }

  const prompt = buildQuizPrompt(context, topic, age);
  
  if (stream) {
    // For quiz, stream the raw response and accumulate JSON
    const encoder = new TextEncoder();
    const customReadable = new ReadableStream({
      async start(controller) {
        try {
          const llmStart = Date.now();
          let fullResponse = "";
          for await (const chunk of generateAnswerStream(prompt)) {
            fullResponse += chunk;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
          const llmTime = Date.now() - llmStart;
          const totalTime = Date.now() - startTime;
          
          const cleanedQuiz = fullResponse
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
          
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
  const llmStart = Date.now();
  const quiz = await generateAnswer(prompt);
  const llmTime = Date.now() - llmStart;
  console.log(`[quiz] LLM generation took ${llmTime}ms`);

  let cleanedQuiz = quiz
  .replace(/```json/g, "")
  .replace(/```/g, "")
  .trim();

  // Extract JSON array if there's preamble text
  if (!cleanedQuiz.startsWith("[")) {
    const arrayStart = cleanedQuiz.indexOf("[");
    if (arrayStart !== -1) {
      cleanedQuiz = cleanedQuiz.substring(arrayStart);
    }
  }

  // If LLM returned empty array or non-JSON, return fallback message
  if (cleanedQuiz === "[]" || cleanedQuiz === "" || !cleanedQuiz.startsWith("[")) {
    const totalTime = Date.now() - startTime;
    console.log(`[quiz] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
    return NextResponse.json({
      quiz: "I don't know. Please ask a parent to add more information."
    });
  }

  const totalTime = Date.now() - startTime;
  console.log(`[quiz] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
  return NextResponse.json({ quiz: cleanedQuiz, _timing: { totalTime, retrievalTime, llmTime } });
}