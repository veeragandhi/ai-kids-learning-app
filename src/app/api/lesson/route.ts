import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";
import { verifyChildOwnership } from "@/lib/supabase/requireChild";
import { BLANK_MARKER, OCR_MARKER_GUARD, toTeachingText } from "@/lib/ocr";
import { conceptCoverage, extractImportantConcepts } from "@/lib/concepts";
import { cleanLessonText, findCopiedSentences } from "@/lib/lessonText";

// Add OPTIONS for CORS
export async function OPTIONS() {
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

// Word budget scales with the amount of important content: a rich worksheet
// gets room for all its concepts, a simple one stays short. Never a fixed
// few-sentence cap that would drop concepts.
function lessonWordBudget(age: number, conceptCount = 0): number {
  const base = age <= 6 ? 80 : age <= 9 ? 120 : 160;
  const cap = age <= 6 ? 180 : age <= 9 ? 230 : 280;
  return Math.min(cap, base + 15 * Math.max(0, conceptCount));
}

function buildLessonPrompt(context: string, topic: string, age: number, concepts: string[] = []) {
  const conceptBlock =
    concepts.length > 0
      ? `\nIMPORTANT CONCEPTS (cover EVERY one below in your own simple words, one or two short sentences each — do not stop after the first few):\n${concepts.map((c) => `- ${c}`).join("\n")}\n`
      : "";
  return `You are a friendly teacher writing a mini-lesson for a ${age}-year-old child.

TOPIC: "${topic}"
LENGTH: at most ${lessonWordBudget(age, concepts.length)} words
READING LEVEL: ${ageGuidance(age)}
${conceptBlock}
OUTPUT SHAPE (follow exactly):
- Line 1: a short title of 2-6 words. No numbering, no "Lesson:" prefix.
- Then: short paragraphs that teach the ideas in your own words.

WRITING RULES:
- Write 1 to 3 complete sentences per paragraph. Every sentence must end with a period, question mark, or exclamation mark.
- Use YOUR OWN WORDS. If you copy more than 5 words in a row from the context, you fail.
- Never state the same idea twice in different words. Make every sentence add something new.
- Use correct English grammar. Subject and verb must agree ("elephants have", not "elephants has").
- Do not start any line with a number, letter, bullet, or dash.
- Do not use markdown such as *, #, or numbered lists.
- If you see repeated words or phrases in the context (like "the the" or "reach reach"), fix them. Do not copy mistakes.
- NEVER say "the text says", "in this chapter", or "the image shows". Speak directly to the child.

HARD RULES:
1. Use ONLY the facts in the CONTEXT below. Never add facts from outside it.
2. If the CONTEXT is primarily about a different topic (e.g., the topic is "Plants" but the text is 90% about "Weather"), reply with the "I don't know" message.
3. Explain the ideas in YOUR OWN simple words. Do NOT copy sentences from the context word-for-word. Rephrase everything to be child-friendly.
4. If the context contains a scientific explanation about air expanding or contracting, explain it simply (e.g., "warm air takes up more space").
5. Never copy worksheet parts: no question numbers, no instructions, no checkbox marks.
4. Never write HTML or markup such as <br>, and never write ${BLANK_MARKER} or [ ].
5. Do not ask the child questions and do not include a quiz or numbered list.
6. Do not copy worksheet section headers such as "Think About It", "Amazing Fact", or "Discover". Teach every fact as a plain paragraph of its own.
7. If the CONTEXT has nothing about "${topic}", reply with exactly:
   I don't know. Please ask a parent to add more information.

NOTE: ${OCR_MARKER_GUARD}

CONTEXT:
${context}

Write the lesson about "${topic}" now.

LESSON:`;
}

// One guided revision when coverage validation finds taught concepts missing
// from the first draft, or copy detection finds sentences lifted verbatim
// from the context. Only those listed fixes may be applied; nothing else may
// change, and no facts beyond CONTEXT may appear.
function buildRevisionPrompt(
  draft: string,
  missing: string[],
  copies: string[],
  topic: string,
  age: number,
  context: string,
) {
  const missingBlock =
    missing.length > 0
      ? `\nMISSING IDEAS (weave EACH one below into the lesson in your own simple words, one short sentence each):\n${missing.map((c) => `- ${c}`).join("\n")}\n`
      : "";
  const copiesBlock =
    copies.length > 0
      ? `\nCOPIED SENTENCES (these copy the context word for word — write EACH one again with completely different words, keeping every fact):\n${copies.map((c) => `- ${c}`).join("\n")}\n`
      : "";
  const fixes =
    [
      missing.length > 0 ? "Add the missing ideas above, each in one short sentence." : "",
      copies.length > 0 ? "Rewrite the copied sentences above with new wording." : "",
    ]
      .filter(Boolean)
      .join(" ") || "Improve the wording without changing the content.";
  return `You are a friendly teacher revising a mini-lesson for a ${age}-year-old child.

TOPIC: "${topic}"
LENGTH: at most ${lessonWordBudget(age, missing.length + copies.length + 3)} words
READING LEVEL: ${ageGuidance(age)}

YOUR FIRST DRAFT (keep its style and all its correct content):
${draft}
${missingBlock}${copiesBlock}
RULES:
- Keep the title line and every good sentence of the draft that is not listed above.
- ${fixes} Do NOT add any other facts.
- Write EVERY sentence in your own words. If a sentence matches the CONTEXT word for word, you fail.
- Never state the same idea twice in different words.
- Use ONLY facts from the CONTEXT below. Never invent facts.
- 1 to 3 complete sentences per paragraph. No lists, no markdown, no questions, no quiz.
- Never write HTML or markup, and never write ${BLANK_MARKER} or [ ].

NOTE: ${OCR_MARKER_GUARD}

CONTEXT:
${context}

Write the revised lesson about "${topic}" now.

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
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const age = clampAge(body.age);

    if (!topic) {
      return NextResponse.json({ error: "A topic is required" }, { status: 400 });
    }

    // Per-child isolation: verify ownership before any retrieval. Missing or
    // foreign childId fails closed — never fall back to all documents.
    const verified = await verifyChildOwnership(req, body.childId);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: verified.status });
    }

    console.log(`[lesson] Generating lesson for topic: ${topic}, age: ${age}, stream: ${stream}`);

    const retrievalStart = Date.now();
    // Broad recall for concept identification (same breadth as Quiz): the
    // concept list — not raw dump size — decides what enters the lesson.
    // Scoped to the verified child BEFORE scoring (see lib/retrieval.ts).
    const context = await getRelevantContext(topic, 5, 0.30, { childId: verified.childId });
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
    // Internal concept list: what the child is expected to learn. Never
    // exposed to the child; it drives the prompt and coverage validation.
    const conceptStart = Date.now();
    const concepts = extractImportantConcepts(teachingContext, topic);
    console.log(`[lesson] identified ${concepts.length} concepts in ${Date.now() - conceptStart}ms`);

    // Topic Guard: If no concepts were found that actually match the topic,
    // don't let the LLM hallucinate a lesson.
    if (concepts.length === 0) {
      console.log("[lesson] No relevant concepts found for topic:", topic);
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

    const prompt = buildLessonPrompt(teachingContext, topic, age, concepts);
    // Longer lessons need headroom beyond the default prediction budget.
    const numPredict = concepts.length <= 3 ? 300 : Math.min(800, 150 + 80 * concepts.length);
    
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
    const lesson = await generateAnswer(prompt, numPredict);
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

    // Concept coverage + verbatim-copy validation: one guided revision when
    // the draft dropped important concepts or copied the context word for
    // word. Keep the better version on both dimensions.
    let coverage = conceptCoverage(cleanedLesson, concepts);
    let copies = findCopiedSentences(cleanedLesson, teachingContext);
    const flaggedCopies = copies.length;
    let revised = false;
    console.log(
      `[lesson] concept coverage: ${coverage.covered}/${coverage.total}, copied sentences: ${flaggedCopies}`,
    );
    if (coverage.missing.length > 0 || copies.length > 0) {
      try {
        const revisionStart = Date.now();
        const revision = await generateAnswer(
          buildRevisionPrompt(cleanedLesson, coverage.missing, copies, topic, age, teachingContext),
          numPredict,
        );
        const revisionTime = Date.now() - revisionStart;
        console.log(`[lesson] revision took ${revisionTime}ms`);
        if (revision) {
          let cleanedRevision = cleanLessonText(revision);
          if (cleanedRevision.startsWith("I don't know")) {
            cleanedRevision = cleanedRevision
              .replace(/^I don't know\.\s+Please ask a parent to add more information\.\n*/, "")
              .trim();
          }
          if (cleanedRevision) {
            const revisionCoverage = conceptCoverage(cleanedRevision, concepts);
            const revisionCopies = findCopiedSentences(cleanedRevision, teachingContext);
            console.log(
              `[lesson] revised coverage: ${revisionCoverage.covered}/${revisionCoverage.total}, copied: ${revisionCopies.length}`,
            );
            // Accept when nothing regresses, or when the coverage gain is at
            // least the copy cost (never trade more verbatim sentences for
            // fewer taught concepts than we gain).
            const coverageGain = revisionCoverage.covered - coverage.covered;
            const copyCost = revisionCopies.length - copies.length;
            const acceptable =
              (revisionCoverage.covered >= coverage.covered &&
                revisionCopies.length <= copies.length) ||
              (coverageGain > 0 && coverageGain >= copyCost);
            if (acceptable) {
              cleanedLesson = cleanedRevision;
              coverage = revisionCoverage;
              copies = revisionCopies;
              revised = true;
            }
          }
        }
      } catch (revisionError) {
        console.error("[lesson] revision failed, keeping first draft:", revisionError);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[lesson] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
    return NextResponse.json({
      lesson: cleanedLesson,
      age,
      _timing: { totalTime, retrievalTime, llmTime },
      _coverage: { important: coverage.total, covered: coverage.covered, revised },
      _copies: { flagged: flaggedCopies, remaining: copies.length },
    });
  } catch (error) {
    console.error("[lesson] Fatal error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Server error: ${errorMessage}` },
      { status: 500 }
    );
  }
}