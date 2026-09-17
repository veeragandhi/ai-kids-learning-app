import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";
import { BLANK_MARKER, OCR_MARKER_GUARD, toTeachingText } from "@/lib/ocr";

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

function clampAge(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(3, Math.min(18, Math.floor(n))) : 8;
}

// Age-appropriate reading level (mirrors the age bands used by /api/quiz).
function ageGuidance(age: number): string {
  if (age <= 6) {
    return "Use VERY simple words of 1-2 syllables. Keep sentences to 5-8 words. Talk like you are explaining to a small child.";
  }
  if (age <= 9) {
    return "Use simple, clear words. Keep sentences to about 12 words. Explain any new word in a few words.";
  }
  return "Use clear words and some topic vocabulary. Keep sentences to about 15 words. Add one \"why\" or \"how\" detail.";
}

function lessonWordBudget(age: number): number {
  if (age <= 6) return 80;
  if (age <= 9) return 120;
  return 160;
}

function buildLessonPrompt(context: string, topic: string, age: number) {
  return `You are a friendly teacher writing a mini-lesson for a ${age}-year-old child.

TOPIC: "${topic}"
LENGTH: at most ${lessonWordBudget(age)} words
READING LEVEL: ${ageGuidance(age)}

OUTPUT SHAPE (follow exactly):
- Line 1: a short title of 2-6 words. No numbering, no "Lesson:" prefix.
- Then: 2 or 3 short paragraphs that teach the idea in your own words.

HARD RULES:
1. Use ONLY the facts in the CONTEXT below. Never add facts from outside it.
2. Explain the ideas in YOUR OWN simple words. Do NOT copy sentences from the context word-for-word.
3. Never copy worksheet parts: no question numbers, no "Tick/Match/Fill/Circle" instructions, no answer options like "(a / b)", no checkbox marks.
4. Never write HTML or markup such as <br>, and never write ${BLANK_MARKER} or [ ].
5. Do not ask the child questions and do not include a quiz or numbered list.
6. If the CONTEXT has nothing about "${topic}", reply with exactly:
   I don't know. Please ask a parent to add more information.

NOTE: ${OCR_MARKER_GUARD}

CONTEXT:
${context}

Write the lesson about "${topic}" now.

LESSON:`;
}

// Safety net for the small model: strip markup and any worksheet scaffolding
// that leaked past the prompt rules.
function cleanLessonText(raw: string): string {
  const out = (raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*LESSON\s*:\s*/i, "")
    .replace(/^\s*Lesson\s*:\s*/i, "");
  const kept = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => {
      if (!line) return true;
      if (/^\d+\s*[.)]\s/.test(line) && /\([^()\n]{1,60}\/[^()\n]{1,60}\)/.test(line)) {
        return false;
      }
      if (/^\d{1,3}$/.test(line)) return false;
      return true;
    });
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // A lesson must not ask questions (that is the Ask flow's job). Drop trailing
  // question chatter such as "Would you like to learn more?" from the end only,
  // and never shorten the lesson below teaching size.
  const withoutTail = cleaned.replace(/(?:\n+[^\n?]*\?)+\s*$/, "").trim();
  if (withoutTail && withoutTail.split(/\s+/).length >= 20) {
    return withoutTail;
  }
  return cleaned;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  console.log("[lesson] POST request started");
  
  try {
    // Check if streaming is requested
    const url = new URL(req.url);
    const stream = url.searchParams.get("stream") === "true";
    
    const body = await req.json();
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const age = clampAge(body.age);

    if (!topic) {
      return NextResponse.json({ error: "A topic is required" }, { status: 400 });
    }

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

    // Teach from prose, never from the worksheet's exercises. Falls back to the
    // raw context when the text is not a worksheet.
    const teachingContext = toTeachingText(context);
    const prompt = buildLessonPrompt(teachingContext, topic, age);
    
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
    console.log("[lesson] STEP 6 - calling LLM");
    console.log("[lesson] prompt length:", prompt.length);
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

    // Clean up the response: strip markup/scaffolding, then remove an
    // "I don't know" preamble if the model still added one.
    let cleanedLesson = cleanLessonText(lesson);
    if (cleanedLesson.startsWith("I don't know")) {
      // If response is ONLY "I don't know", return it as-is
      if (cleanedLesson === "I don't know. Please ask a parent to add more information.") {
        const totalTime = Date.now() - startTime;
        console.log(`[lesson] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
        return NextResponse.json({ lesson: cleanedLesson, age });
      }
      // Otherwise, remove the preamble and keep the actual content
      cleanedLesson = cleanedLesson.replace(/^I don't know\.\s+Please ask a parent to add more information\.\n*/, "").trim();
    }

    if (!cleanedLesson) {
      console.error("[lesson] Lesson was empty after cleaning");
      return NextResponse.json(
        { error: "The lesson came back empty. Please try again." },
        { status: 502 }
      );
    }

    const totalTime = Date.now() - startTime;
    console.log(`[lesson] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
    return NextResponse.json({ lesson: cleanedLesson, age, _timing: { totalTime, retrievalTime, llmTime } });
  } catch (error) {
    console.error("[lesson] Fatal error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Server error: ${errorMessage}` },
      { status: 500 }
    );
  }
}