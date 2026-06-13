import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

// Add OPTIONS for CORS
export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function buildLessonPrompt(context: string, topic: string, age: number) {
  return `You are a strict teacher for a ${age}-year-old child.

CRITICAL - READ THIS FIRST:
- Topic to teach: "${topic}"
- You MUST teach ONLY about "${topic}"
- Any content not about "${topic}" is IRRELEVANT and must be ignored
- Create a lesson of MAXIMUM 200 words

HARD RULES (violating these loses all credibility):
1. Use ONLY the context provided below about "${topic}"
2. If the context does NOT contain information about "${topic}", respond EXACTLY:
   I don't know. Please ask a parent to add more information.
3. Do NOT invent, assume, or add any facts not in the context
4. Do NOT include unrelated information (even if in context)
5. Do NOT make up stories, examples, or figures
6. Do NOT explain why you can't answer - just say "I don't know"

CONTEXT ABOUT "${topic}":
${context}

Now, create the lesson about "${topic}" using ONLY the provided context.
If the context doesn't describe "${topic}", respond with ONLY:
I don't know. Please ask a parent to add more information.

LESSON:`;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  console.log("[lesson] POST request started");
  
  try {
    // Check if streaming is requested
    const url = new URL(req.url);
    const stream = url.searchParams.get("stream") === "true";
    
    const body = await req.json();
    const { topic, age = 5 } = body;

    console.log(`[lesson] Generating lesson for topic: ${topic}, age: ${age}, stream: ${stream}`);

    const retrievalStart = Date.now();
    const context = await getRelevantContext(topic);
    const retrievalTime = Date.now() - retrievalStart;
    console.log(`[lesson] RAG retrieval took ${retrievalTime}ms`);

    if (!context || context.trim().length === 0) {
      console.log(`[lesson] No context found, total time: ${Date.now() - startTime}ms`);
      return new NextResponse(
        JSON.stringify({
          lesson: "I don't know. Please ask a parent to add more information."
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    const prompt = buildLessonPrompt(context, topic, age);
    
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
            console.error("[lesson] streaming error:", error);
            controller.error(error);
          }
        }
      });

      return new NextResponse(customReadable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Non-streaming response (original behavior)
    console.log("[lesson] Calling generateAnswer...");
    const llmStart = Date.now();
    const lesson = await generateAnswer(prompt);
    const llmTime = Date.now() - llmStart;
    console.log(`[lesson] LLM generation took ${llmTime}ms, response length: ${lesson?.length || 0}`);

    if (!lesson) {
      console.error("[lesson] No response from LLM");
      return NextResponse.json(
        { error: "LLM did not return a response" },
        { status: 500 }
      );
    }

    // Clean up the response - remove "I don't know" preamble if it appears at the start
    let cleanedLesson = lesson.trim();
    if (cleanedLesson.startsWith("I don't know")) {
      // If response is ONLY "I don't know", return it as-is
      if (cleanedLesson === "I don't know. Please ask a parent to add more information.") {
        const totalTime = Date.now() - startTime;
        console.log(`[lesson] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
        return NextResponse.json({ lesson: cleanedLesson });
      }
      // Otherwise, remove the preamble and keep the actual content
      cleanedLesson = cleanedLesson.replace(/^I don't know\.\s+Please ask a parent to add more information\.\n\n/, "").trim();
    }

    const totalTime = Date.now() - startTime;
    console.log(`[lesson] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
    return NextResponse.json({ lesson: cleanedLesson, _timing: { totalTime, retrievalTime, llmTime } });
  } catch (error) {
    console.error("[lesson] Fatal error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Server error: ${errorMessage}` },
      { status: 500 }
    );
  }
}