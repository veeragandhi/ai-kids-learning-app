import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

function fixQuizAnswers(quiz: any): any {
  // Try to fix answers that are close to options (typos)
  return quiz.map((q: any) => {
    const { answer, options } = q;
    
    // If answer already matches, return as-is
    if (options.includes(answer)) {
      return q;
    }
    
    // Try to find closest match (simple string similarity)
    let bestMatch = options[0];
    let bestScore = 0;
    
    for (const option of options) {
      // Calculate simple similarity
      const lowerAnswer = answer.toLowerCase();
      const lowerOption = option.toLowerCase();
      
      if (lowerAnswer === lowerOption) {
        bestMatch = option;
        break;
      }
      
      // Check if one contains the other or shares significant words
      const answerWords = lowerAnswer.split(/\s+/);
      const optionWords = lowerOption.split(/\s+/);
      
      const commonWords = answerWords.filter(w => optionWords.includes(w)).length;
      const score = commonWords / Math.max(answerWords.length, optionWords.length);
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = option;
      }
    }
    
    // Use best match if similarity is reasonable (> 0.5)
    return {
      ...q,
      answer: bestScore > 0.5 ? bestMatch : answer
    };
  });
}

function validateQuizFormat(quiz: any): boolean {
  if (!Array.isArray(quiz)) {
    console.error("[quiz] Invalid format: quiz is not an array");
    return false;
  }
  
  return quiz.every((q, idx) => {
    // Check required fields exist
    if (!q.question) {
      console.error(`[quiz] Question ${idx}: missing 'question' field`);
      return false;
    }
    if (!q.options) {
      console.error(`[quiz] Question ${idx}: missing 'options' field`);
      return false;
    }
    if (!q.answer) {
      console.error(`[quiz] Question ${idx}: missing 'answer' field`);
      return false;
    }
    
    // Check types
    if (typeof q.question !== "string") {
      console.error(`[quiz] Question ${idx}: 'question' is not a string`);
      return false;
    }
    if (!Array.isArray(q.options)) {
      console.error(`[quiz] Question ${idx}: 'options' is not an array`);
      return false;
    }
    if (typeof q.answer !== "string") {
      console.error(`[quiz] Question ${idx}: 'answer' is not a string`);
      return false;
    }
    
    // Check options are all strings
    if (!q.options.every((opt: any) => typeof opt === "string")) {
      console.error(`[quiz] Question ${idx}: not all options are strings`);
      return false;
    }
    
    // Check exactly 3 options
    if (q.options.length !== 3) {
      console.error(`[quiz] Question ${idx}: has ${q.options.length} options, need exactly 3`);
      return false;
    }
    
    // Check answer is in options
    if (!q.options.includes(q.answer)) {
      console.error(`[quiz] Question ${idx}: answer "${q.answer}" not in options [${q.options.map(o => `"${o}"`).join(", ")}]`);
      return false;
    }
    
    return true;
  });
}

function buildQuizPrompt(
  context: string,
  topic: string,
  age: number
) {
  return `You are a quiz creator for a ${age}-year-old child.

ONLY OUTPUT VALID JSON. NO OTHER TEXT OR FORMATTING.

EXACTLY 3 questions. EXACTLY 3 options each.

Return ONLY this JSON format (nothing else, no markdown, no quotes, just JSON):

[{"question":"What do dinosaurs eat?","options":["Plants","Meat","Ice cream"],"answer":"Meat"},{"question":"When did dinosaurs live?","options":["100 years ago","1 million years ago","65 million years ago"],"answer":"65 million years ago"},{"question":"How big was a T-Rex?","options":["Small like a cat","Big like a bus","Huge like a mountain"],"answer":"Big like a bus"}]

RULES:
- Answer must EXACTLY match one of the 3 options
- No triple quotes, no markdown, no line breaks in strings
- Only VALID JSON
- Only facts from context

CONTEXT:
${context}

NOW create 3 questions about ${topic}:`;
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
          for await (const chunk of generateAnswerStream(prompt, 2000)) {
            fullResponse += chunk;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
          const llmTime = Date.now() - llmStart;
          const totalTime = Date.now() - startTime;
          
          // Clean the response aggressively
          let cleanedQuiz = fullResponse
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .replace(/"""/g, '"') // Replace triple quotes
            .replace(/,\s*"\s+"/g, '","') // Fix ], " " patterns
            .replace(/"\s*,\s*"\s*answer/g, '","answer') // Fix extra quotes before answer
            .replace(/\n\s*/g, " ") // Replace newlines and spaces
            .trim();

          // Extract JSON array
          if (!cleanedQuiz.startsWith("[")) {
            const arrayStart = cleanedQuiz.indexOf("[");
            if (arrayStart !== -1) {
              cleanedQuiz = cleanedQuiz.substring(arrayStart);
            }
          }

          // Find the end of the JSON array
          if (cleanedQuiz.includes("]")) {
            const arrayEnd = cleanedQuiz.lastIndexOf("]");
            cleanedQuiz = cleanedQuiz.substring(0, arrayEnd + 1);
          }

          try {
            let parsed = JSON.parse(cleanedQuiz);
            parsed = fixQuizAnswers(parsed);
            cleanedQuiz = JSON.stringify(parsed);
          } catch (e) {
            console.error("[quiz] streaming parse error:", e);
          }
          
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
  const quiz = await generateAnswer(prompt, 2000);
  const llmTime = Date.now() - llmStart;
  console.log(`[quiz] LLM generation took ${llmTime}ms`);

  // Aggressively clean the response
  let cleanedQuiz = quiz
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/"""/g, '"') // Replace triple quotes with single quotes
    .replace(/,\s*"\s+"/g, '","') // Fix ], " " patterns
    .replace(/"\s*,\s*"\s*answer/g, '","answer') // Fix extra quotes before answer
    .replace(/\n\s*/g, " ") // Replace newlines and leading spaces
    .trim();

  // Extract JSON array if there's preamble text
  if (!cleanedQuiz.startsWith("[")) {
    const arrayStart = cleanedQuiz.indexOf("[");
    if (arrayStart !== -1) {
      cleanedQuiz = cleanedQuiz.substring(arrayStart);
    }
  }

  // Find the end of the JSON array
  if (cleanedQuiz.includes("]")) {
    const arrayEnd = cleanedQuiz.lastIndexOf("]");
    cleanedQuiz = cleanedQuiz.substring(0, arrayEnd + 1);
  }

  // Try to parse and validate
  try {
    if (cleanedQuiz === "[]" || cleanedQuiz === "" || !cleanedQuiz.startsWith("[")) {
      throw new Error("Empty or invalid response");
    }

    let parsed = JSON.parse(cleanedQuiz);
    
    // Try to fix answer mismatches
    parsed = fixQuizAnswers(parsed);
    
    // Validate the format
    if (!validateQuizFormat(parsed)) {
      console.error("[quiz] Invalid quiz format after fixes:", JSON.stringify(parsed));
      const totalTime = Date.now() - startTime;
      return NextResponse.json({
        quiz: "I don't know. Please ask a parent to add more information."
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[quiz] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
    // Return the fixed parsed version as JSON string
    return NextResponse.json({ quiz: JSON.stringify(parsed), _timing: { totalTime, retrievalTime, llmTime } });
  } catch (error) {
    console.error("[quiz] JSON parse error:", error, "Raw:", cleanedQuiz);
    const totalTime = Date.now() - startTime;
    return NextResponse.json({
      quiz: "I don't know. Please ask a parent to add more information."
    });
  }
}