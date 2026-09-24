import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";
import { BLANK_MARKER, OCR_MARKER_GUARD, toTeachingText } from "@/lib/ocr";
import { conceptCoverage, extractImportantConcepts } from "@/lib/concepts";

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
- Use correct English grammar. Subject and verb must agree ("elephants have", not "elephants has").
- Do not start any line with a number, letter, bullet, or dash.
- Do not use markdown such as *, #, or numbered lists.

HARD RULES:
1. Use ONLY the facts in the CONTEXT below. Never add facts from outside it. If the CONTEXT does not contain the answer, say so plainly.
2. Explain the ideas in YOUR OWN simple words. Do NOT copy sentences from the context word-for-word.
3. Never copy worksheet parts: no question numbers, no "Tick/Match/Fill/Circle" instructions, no answer options like "(a / b)", no checkbox marks.
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
// from the first draft. Only the missing ideas are added; nothing else may
// change, and no facts beyond CONTEXT may appear.
function buildRevisionPrompt(
  draft: string,
  missing: string[],
  topic: string,
  age: number,
  context: string,
) {
  return `You are a friendly teacher revising a mini-lesson for a ${age}-year-old child.

TOPIC: "${topic}"
LENGTH: at most ${lessonWordBudget(age, missing.length + 3)} words
READING LEVEL: ${ageGuidance(age)}

YOUR FIRST DRAFT (keep its style and all its correct content):
${draft}

MISSING IDEAS (weave EACH one below into the lesson in your own simple words, one short sentence each):
${missing.map((c) => `- ${c}`).join("\n")}

RULES:
- Keep the title line and every good sentence of the draft.
- Add only the missing ideas above. Do NOT add any other facts.
- Use ONLY facts from the CONTEXT below. Never invent facts.
- 1 to 3 complete sentences per paragraph. No lists, no markdown, no questions, no quiz.
- Never write HTML or markup, and never write ${BLANK_MARKER} or [ ].

NOTE: ${OCR_MARKER_GUARD}

CONTEXT:
${context}

Write the revised lesson about "${topic}" now.

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
  const lines = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .map((line) => stripMetaPrefix(line))
    .map((line) => stripWorksheetSection(line))
    .filter((line) => {
      if (!line) return true;
      // Worksheet scaffolding: numbered option lines like "1. (a / b)".
      if (/^\d+\s*[.)]\s/.test(line) && /\([^()\n]{1,60}\/[^()\n]{1,60}\)/.test(line)) {
        return false;
      }
      if (/^\d{1,3}$/.test(line)) return false;
      // A lesson never asks the child questions (that is the Ask flow's
      // job): drop "Could it reach something far away?"-style lines
      // wherever they appear, not just at the tail.
      if (line.includes("?")) return false;
      return true;
    })
    .map((line) => stripLinePrefix(line))
    .filter((line, index, arr) => {
      // Drop a line that became empty after stripping, but keep paragraph breaks.
      if (line) return true;
      // Keep at most one blank line in a row.
      return index === 0 || arr[index - 1] !== "";
    });
  const withPunctuation = lines.map((line, index) =>
    index === 0 ? line : ensureSentencePunctuation(line),
  );
  const joined = withPunctuation.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // A lesson must not ask questions (that is the Ask flow's job). Drop trailing
  // question chatter such as "Would you like to learn more?" from the end only,
  // and never shorten the lesson below teaching size.
  const withoutTail = joined.replace(/(?:\n+[^\n?]*\?)+\s*$/, "").trim();
  if (withoutTail && withoutTail.split(/\s+/).length >= 20) {
    return withoutTail;
  }
  return joined;
}

// Strip worksheet section scaffolding the small model copies from the source
// ("Thinking About It:", "✨ Amazing Fact: ... ✨"). Standalone labels are
// dropped; inline labels are unwrapped so the taught fact survives as a
// plain paragraph.
function stripWorksheetSection(line: string): string {
  if (!line) return line;
  if (/^\W*(thinking about it|think about it|amazing fact|fun fact|did you know|discover|key words?)\W*$/i.test(line)) {
    return "";
  }
  return line
    .replace(/[✨⭐🌟💡📌🤔]/gu, "")
    .replace(/^\s*(amazing fact|fun fact|did you know)\s*:\s*/i, "")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
}

// Strip meta labels the small model narrates about its own output
// ("Title:", "A short title:", "Read carefully:", "Introduction:").
function stripMetaPrefix(line: string): string {
  if (!line) return line;
  return line
    .replace(/^\s*(?:a\s+short\s+title|short\s+title|title|topic|read\s+carefully|introduction|intro|note)\s*:\s+/i, "")
    .trim();
}

// Strip leading list prefixes that the small model sometimes emits ("1.", "2)",
// "- ", "* ", "• ", "Line 1:"). Keep the line content.
function stripLinePrefix(line: string): string {
  if (!line) return line;
  // Apply repeatedly: the model stacks prefixes ("1. Line 2:", "- 3. text").
  let stripped = line;
  for (let i = 0; i < 3; i++) {
    const next = stripped
      // "Line 1:", "line 2 -", "Step 1:" style prefixes kids reported seeing.
      .replace(/^\s*(?:line|step|point|para(?:graph)?)\s*\d{1,3}\s*[:.)\-–—]?\s+/i, "")
      // "1. " or "1) " — must be followed by a letter so we don't strip years.
      .replace(/^\s*\d{1,3}\s*[.)]\s+(?=[A-Za-z])/, "")
      // "- " / "* " / "• " bullets
      .replace(/^\s*[-*•]\s+(?=[A-Za-z])/, "");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped.trim();
}

// Make sure each non-empty body line ends with punctuation. The small model
// often forgets the final period, which hurts grammar and read-aloud rhythm.
function ensureSentencePunctuation(line: string): string {
  if (!line) return line;
  if (/[.!?:"")]$/.test(line)) return line;
  return `${line}.`;
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
    // Broad recall for concept identification (same breadth as Quiz): the
    // concept list — not raw dump size — decides what enters the lesson.
    const context = await getRelevantContext(topic, 5, 0.30);
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

    // Concept coverage validation: revise once when the draft dropped
    // important concepts. Keep the better-covered version either way.
    let coverage = conceptCoverage(cleanedLesson, concepts);
    let revised = false;
    console.log(`[lesson] concept coverage: ${coverage.covered}/${coverage.total}`);
    if (concepts.length > 0 && coverage.missing.length > 0) {
      try {
        const revisionStart = Date.now();
        const revision = await generateAnswer(
          buildRevisionPrompt(cleanedLesson, coverage.missing, topic, age, teachingContext),
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
            console.log(`[lesson] revised coverage: ${revisionCoverage.covered}/${revisionCoverage.total}`);
            if (revisionCoverage.covered >= coverage.covered) {
              cleanedLesson = cleanedRevision;
              coverage = revisionCoverage;
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