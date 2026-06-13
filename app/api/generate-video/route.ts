import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VideoSlide {
  id: number;
  type: "title" | "fact" | "example" | "outro";
  heading: string;
  body: string;
  emoji: string;       // big visual emoji for the slide
  gradient: string;    // tailwind gradient classes
  durationSeconds: number;
}

export interface VideoScript {
  topic: string;
  age: number;
  totalDuration: number;
  slides: VideoSlide[];
}

// ─── Topic → emoji + gradient palette ────────────────────────────────────────

function getTopicTheme(topic: string): { emoji: string; gradients: string[] } {
  const t = topic.toLowerCase();

  if (/plant|flower|tree|leaf|grass|seed|root|photosynthes/.test(t))
    return { emoji: "🌿", gradients: ["from-green-400 to-emerald-600", "from-lime-300 to-green-500", "from-emerald-400 to-teal-600", "from-green-300 to-lime-500", "from-teal-400 to-green-600"] };
  if (/animal|lion|tiger|elephant|dog|cat|bird|fish|bear|wolf/.test(t))
    return { emoji: "🦁", gradients: ["from-amber-400 to-orange-600", "from-yellow-300 to-amber-500", "from-orange-400 to-red-500", "from-amber-300 to-yellow-500", "from-orange-300 to-amber-600"] };
  if (/space|planet|star|moon|sun|galaxy|rocket|astronaut|cosmos/.test(t))
    return { emoji: "🚀", gradients: ["from-indigo-600 to-purple-800", "from-violet-500 to-indigo-700", "from-blue-600 to-indigo-800", "from-purple-500 to-violet-700", "from-indigo-500 to-blue-700"] };
  if (/dinosaur|dino|fossil|prehistoric|jurassic/.test(t))
    return { emoji: "🦕", gradients: ["from-lime-500 to-green-700", "from-green-400 to-lime-600", "from-emerald-500 to-green-700", "from-lime-400 to-emerald-600", "from-green-500 to-teal-700"] };
  if (/ocean|sea|water|fish|shark|whale|coral|reef|marine/.test(t))
    return { emoji: "🐋", gradients: ["from-blue-400 to-cyan-600", "from-cyan-400 to-blue-600", "from-sky-400 to-blue-600", "from-blue-300 to-cyan-500", "from-cyan-500 to-teal-600"] };
  if (/solar|sun|mercury|venus|mars|jupiter|saturn|uranus|neptune/.test(t))
    return { emoji: "☀️", gradients: ["from-yellow-400 to-orange-600", "from-orange-400 to-red-600", "from-amber-400 to-yellow-600", "from-red-400 to-orange-600", "from-yellow-300 to-amber-500"] };
  if (/human|body|heart|brain|blood|bone|muscle|organ/.test(t))
    return { emoji: "🫀", gradients: ["from-red-400 to-pink-600", "from-pink-400 to-rose-600", "from-rose-400 to-red-600", "from-red-300 to-rose-500", "from-pink-500 to-red-600"] };
  if (/weather|cloud|rain|snow|wind|storm|thunder|climate/.test(t))
    return { emoji: "⛅", gradients: ["from-sky-400 to-blue-600", "from-blue-300 to-sky-500", "from-cyan-400 to-sky-600", "from-sky-300 to-cyan-500", "from-blue-400 to-indigo-500"] };
  if (/math|number|count|add|subtract|multiply|divide|shape/.test(t))
    return { emoji: "🔢", gradients: ["from-violet-400 to-purple-600", "from-purple-400 to-violet-600", "from-indigo-400 to-purple-500", "from-violet-300 to-purple-500", "from-purple-500 to-indigo-600"] };
  if (/history|ancient|egypt|rome|war|king|queen|castle|knight/.test(t))
    return { emoji: "🏰", gradients: ["from-amber-500 to-yellow-700", "from-yellow-400 to-amber-600", "from-orange-400 to-amber-600", "from-amber-400 to-orange-600", "from-yellow-500 to-orange-600"] };

  // Default
  return { emoji: "🌟", gradients: ["from-sky-400 to-violet-600", "from-violet-400 to-pink-600", "from-pink-400 to-orange-500", "from-orange-400 to-amber-500", "from-teal-400 to-sky-600"] };
}

const SLIDE_EMOJIS: Record<VideoSlide["type"], string[]> = {
  title:   ["🌟", "✨", "🎯", "🎉"],
  fact:    ["💡", "🔍", "📖", "🧠", "💫", "🌈"],
  example: ["🔎", "👀", "🤔", "💭"],
  outro:   ["🎉", "🏆", "⭐", "🥳"],
};

// ─── Prompt ───────────────────────────────────────────────────────────────────

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildVideoScriptPrompt(context: string, topic: string, age: number): string {
  return `You are creating a short educational video for a ${age}-year-old child about "${topic}".

Use ONLY the context below. Do NOT add facts that aren't in the context.

CONTEXT:
${context}

Provide EXACTLY this format (plain text, no JSON):

TITLE: [short catchy title, max 5 words]
BODY: [one simple sentence for intro, max 15 words]
---
FACT1_HEADING: [one fact heading, max 5 words]
FACT1_BODY: [one fact sentence from context, max 15 words]
---
FACT2_HEADING: [another fact heading, max 5 words]
FACT2_BODY: [another fact sentence from context, max 15 words]
---
EXAMPLE_HEADING: [example heading, max 5 words]
EXAMPLE_BODY: [child-friendly example, max 15 words]
---
OUTRO_HEADING: [closing heading, max 5 words]
OUTRO_BODY: [encouraging closing, max 10 words]

Return ONLY the text format above, nothing else.`;
}

// Parse text-based slide format into structured slides
function parseTextSlidesToJSON(text: string): { type: VideoSlide["type"]; heading: string; body: string }[] {
  const sections = text.split("---").map((s) => s.trim()).filter((s) => s.length > 0);

  const slides: { type: VideoSlide["type"]; heading: string; body: string }[] = [];

  // Title
  if (sections[0]) {
    const titleLines = sections[0].split("\n").filter((l) => l.trim());
    const title = titleLines.find((l) => l.startsWith("TITLE:"))?.replace("TITLE:", "").trim() || "Learn Today!";
    const body = titleLines.find((l) => l.startsWith("BODY:"))?.replace("BODY:", "").trim() || "Let's learn something fun!";
    slides.push({ type: "title", heading: title, body });
  }

  // Facts
  for (let i = 1; i < sections.length - 2; i++) {
    const factLines = sections[i].split("\n").filter((l) => l.trim());
    const heading = factLines.find((l) => l.includes("_HEADING:"))?.split(":").slice(1).join(":").trim() || "Fact";
    const body = factLines.find((l) => l.includes("_BODY:"))?.split(":").slice(1).join(":").trim() || "";
    if (body) {
      slides.push({ type: "fact", heading, body });
    }
  }

  // Example
  if (sections[sections.length - 2]) {
    const exLines = sections[sections.length - 2].split("\n").filter((l) => l.trim());
    const exHeading = exLines.find((l) => l.includes("_HEADING:"))?.split(":").slice(1).join(":").trim() || "Example";
    const exBody = exLines.find((l) => l.includes("_BODY:"))?.split(":").slice(1).join(":").trim() || "";
    if (exBody) {
      slides.push({ type: "example", heading: exHeading, body: exBody });
    }
  }

  // Outro
  if (sections[sections.length - 1]) {
    const outroLines = sections[sections.length - 1].split("\n").filter((l) => l.trim());
    const outroHeading = outroLines.find((l) => l.includes("_HEADING:"))?.split(":").slice(1).join(":").trim() || "Great job!";
    const outroBody = outroLines.find((l) => l.includes("_BODY:"))?.split(":").slice(1).join(":").trim() || "You learned something amazing!";
    slides.push({ type: "outro", heading: outroHeading, body: outroBody });
  }

  return slides;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const startTime = Date.now();
    console.log("[generate-video] POST request started");
    
    const body = await req.json();
    const { topic, age = 6 } = body;

    if (!topic) {
      return NextResponse.json({ error: "topic is required" }, { status: 400 });
    }

    // 1. RAG context
    console.log("[generate-video] fetching context for topic:", topic);
    const retrievalStart = Date.now();
    const context = await getRelevantContext(topic);
    const retrievalTime = Date.now() - retrievalStart;
    console.log("[generate-video] context retrieved, length:", context?.length || 0, `(${retrievalTime}ms)`);
    
    if (!context || context.trim().length === 0) {
      return NextResponse.json(
        { error: "No relevant documents found. Please upload documents about this topic first." },
        { status: 404 }
      );
    }

    // 2. LLM → structured slides
    const scriptPrompt = buildVideoScriptPrompt(context, topic, age);
    console.log("[generate-video] calling generateAnswer...");
    const llmStart = Date.now();
    const rawText = await generateAnswer(scriptPrompt);
    const llmTime = Date.now() - llmStart;
    console.log("[generate-video] raw response received", `(${llmTime}ms)`);

    let parsedSlides: { type: VideoSlide["type"]; heading: string; body: string }[];
    try {
      parsedSlides = parseTextSlidesToJSON(rawText);
      if (parsedSlides.length < 3) {
        throw new Error("Not enough slides generated");
      }
    } catch (err) {
      console.error("[generate-video] parse error:", err, "raw:", rawText);
      // Fallback: generate default slides from context
      parsedSlides = [
        { type: "title", heading: "Learn About " + topic, body: "Let's discover something amazing!" },
        { type: "fact", heading: "Key Information", body: context.split("\n")[0] || "Learn more about " + topic },
        { type: "example", heading: "Real Example", body: "See how this works in the real world!" },
        { type: "outro", heading: "Great job!", body: "You learned something new!" },
      ];
    }

    // 3. Assign gradients + emojis — no external image calls
    const theme = getTopicTheme(topic);

    const slides: VideoSlide[] = parsedSlides.map((slide, i) => ({
      ...slide,
      id: i,
      emoji: SLIDE_EMOJIS[slide.type][i % SLIDE_EMOJIS[slide.type].length],
      gradient: theme.gradients[i % theme.gradients.length],
      durationSeconds: slide.type === "title" || slide.type === "outro" ? 4 : 6,
    }));

    // 4. Final script
    const script: VideoScript = {
      topic,
      age,
      totalDuration: slides.reduce((s, sl) => s + sl.durationSeconds, 0),
      slides,
    };

    const totalTime = Date.now() - startTime;
    console.log(`[generate-video] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
    return NextResponse.json({ script, _timing: { totalTime, retrievalTime, llmTime } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[generate-video] error:", msg, error);
    return NextResponse.json(
      { error: "Video generation failed", details: msg },
      { status: 500 }
    );
  }
}