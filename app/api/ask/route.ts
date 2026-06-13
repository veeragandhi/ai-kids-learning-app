import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

export async function GET() {
  return NextResponse.json({ message: "API is working (GET)" });
}

function buildPrompt(context: string, question: string, age: number) {
  return `
You are a teacher for a ${age}-year-old child.

CRITICAL RULES - YOU MUST FOLLOW THESE:
1. Use ONLY the context below
2. Do NOT create, invent, or assume any facts
3. Do NOT add information not in the context
4. Do NOT make up examples or stories
5. Keep answer short and use simple words
6. If the answer is NOT in the context, respond EXACTLY with ONLY:
   I don't know. Please ask a parent to add more information.

Do NOT include this phrase in responses that answer the question.

CONTEXT:
${context}

QUESTION:
${question}

If you cannot answer from the context alone, respond with ONLY:
I don't know. Please ask a parent to add more information.

Otherwise, respond with ONLY the answer (no preamble, no "I don't know" phrase).

ANSWER:
`;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  console.log("[ask] POST request started");
  
  // Check if streaming is requested
  const url = new URL(req.url);
  const stream = url.searchParams.get("stream") === "true";
  
  const body = await req.json();
  const { question, age = 5 } = body;

  // Use RAG retrieval to find relevant context from uploaded documents
  const retrievalStart = Date.now();
  const context = await getRelevantContext(question);
  const retrievalTime = Date.now() - retrievalStart;
  console.log(`[ask] RAG retrieval took ${retrievalTime}ms`);

  if (!context || context.trim().length === 0) {
    console.log(`[ask] No context found, total time: ${Date.now() - startTime}ms`);
    return NextResponse.json({
      answer: "I don't know. Please ask a parent to add more information."
    });
  }

  const prompt = buildPrompt(context, question, age);

  if (stream) {
    // Return streaming response
    const encoder = new TextEncoder();
    const customReadable = new ReadableStream({
      async start(controller) {
        try {
          const llmStart = Date.now();
          for await (const chunk of generateAnswerStream(prompt)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
          const llmTime = Date.now() - llmStart;
          const totalTime = Date.now() - startTime;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, _timing: { totalTime, retrievalTime, llmTime } })}\n\n`));
          controller.close();
        } catch (error) {
          console.error("[ask] streaming error:", error);
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
  const aiAnswer = await generateAnswer(prompt);
  const llmTime = Date.now() - llmStart;
  console.log(`[ask] LLM generation took ${llmTime}ms`);

  // Clean up the response - remove "I don't know" preamble if it appears at the start
  let cleanedAnswer = aiAnswer.trim();
  if (cleanedAnswer.startsWith("I don't know")) {
    // If response is ONLY "I don't know", return it as-is
    if (cleanedAnswer === "I don't know. Please ask a parent to add more information.") {
      const totalTime = Date.now() - startTime;
      console.log(`[ask] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
      return NextResponse.json({
        answer: cleanedAnswer,
        source: "Document",
        _timing: { totalTime, retrievalTime, llmTime }
      });
    }
    // Otherwise, remove the preamble and keep the actual content
    cleanedAnswer = cleanedAnswer.replace(/^I don't know\.\s+Please ask a parent to add more information\.\n\n/, "").trim();
  }

  const totalTime = Date.now() - startTime;
  console.log(`[ask] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);

  return NextResponse.json({
    answer: cleanedAnswer,
    source: "Document",
    _timing: { totalTime, retrievalTime, llmTime }
  });
}