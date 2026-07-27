import { NextResponse } from "next/server";
import { generateAnswer, generateAnswerStream } from "@/lib/ai";
import { getRelevantContext } from "@/lib/retrieval";

function fixQuizAnswers(quiz: any): any {
  // Try to fix answers that are close to options (typos)
  return quiz.map((q: any) => {
    const { answer, options } = q;
    const normalizedOptions = Array.isArray(options) ? options.filter((opt) => typeof opt === "string") : [];
    let normalizedAnswer = "";

    if (typeof answer === "string") {
      normalizedAnswer = answer;
    } else if (Array.isArray(answer) && answer.length > 0) {
      normalizedAnswer = String(answer[0]);
    } else if (answer != null) {
      normalizedAnswer = String(answer);
    }

    if (normalizedOptions.length === 0) {
      return q;
    }

    if (normalizedOptions.includes(normalizedAnswer)) {
      return {
        ...q,
        answer: normalizedAnswer || normalizedOptions[0]
      };
    }

    let bestMatch = normalizedOptions[0];
    let bestScore = 0;

    for (const option of normalizedOptions) {
      const lowerAnswer = normalizedAnswer.toLowerCase();
      const lowerOption = option.toLowerCase();

      if (lowerAnswer === lowerOption) {
        bestMatch = option;
        break;
      }

      const answerWords = lowerAnswer.split(/\s+/);
      const optionWords = lowerOption.split(/\s+/);
      const commonWords = answerWords.filter((w: string) => optionWords.includes(w)).length;
      const score = commonWords / Math.max(answerWords.length, optionWords.length);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = option;
      }
    }

    return {
      ...q,
      answer: bestScore > 0.5 ? bestMatch : normalizedAnswer || normalizedOptions[0]
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
      console.error(`[quiz] Question ${idx}: answer "${q.answer}" not in options [${q.options.map((o: string) => `"${o}"`).join(", ")}]`);
      return false;
    }
    
    return true;
  });
}

function countBraceBalance(text: string) {
  let inString = false;
  let escaped = false;
  let balance = 0;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") balance += 1;
    if (char === "}") balance -= 1;
  }

  return balance;
}

function extractFirstJsonArray(text: string) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (start === -1 && char === "[") {
      start = i;
      depth = 1;
      continue;
    }

    if (start !== -1) {
      if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

function repairQuizJson(raw: string) {
  let cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/"""/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const arrayStart = cleaned.indexOf("[");
  if (arrayStart !== -1) {
    cleaned = cleaned.substring(arrayStart);
  }

  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayEnd !== -1) {
    cleaned = cleaned.substring(0, arrayEnd + 1);
  }

  cleaned = cleaned
    .replace(/"reason"\s*:/g, '"answer":')
    .replace(/}\s*\{/g, '}, {')
    .replace(/}\s*,\s*"options"/g, ', "options"')
    .replace(/}\s*,\s*"answer"/g, ', "answer"')
    .replace(/"answer"\s*:\s*\[\s*"([^"]+?)"[^\]]*\]/g, '"answer":"$1"')
    .replace(/"\s*"(?=(options|answer)"\s*:)/g, '", "')
    .replace(/"\s*,\s*"\s*answer/g, '","answer')
    .replace(/\s*\[\s*,/g, '[')
    .replace(/,\s*\]/g, ']')
    .replace(/,\s*([\]}])/g, '$1')
    .trim();

  const balance = countBraceBalance(cleaned);
  if (balance > 0) {
    cleaned += "}".repeat(balance);
  }

  return cleaned;
}

function extractQuotedStrings(text: string) {
  const result: string[] = [];
  const regex = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    result.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }

  return result;
}

function parseQuizObject(objText: string) {
  const questionMatch = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(objText);
  const optionsMatch = /"options"\s*:\s*\[([^\]]*)\]/i.exec(objText);
  const answerMatch = /"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(objText);

  const question = questionMatch?.[1].replace(/\\"/g, '"');
  const options = optionsMatch ? extractQuotedStrings(optionsMatch[1]) : [];
  let answer = answerMatch?.[1].replace(/\\"/g, '"');

  if (!answer) {
    const afterOptions = optionsMatch ? objText.slice(optionsMatch.index + optionsMatch[0].length) : objText;
    const strayMatch = /"((?:[^"\\]|\\.)*)"/.exec(afterOptions);
    if (strayMatch) {
      const stray = strayMatch[1].replace(/\\"/g, '"');
      if (stray.toLowerCase() !== "answer" && stray.toLowerCase() !== "reason") {
        answer = stray;
      }
    }
  }

  if (!question || options.length === 0) {
    return null;
  }

  const normalizedOptions = options.slice(0, 3);

  return {
    question,
    options: normalizedOptions,
    answer: answer ?? normalizedOptions[0],
  };
}

function parseQuizArrayManually(raw: string) {
  const cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const questionMatches = [...cleaned.matchAll(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)];
  const optionsMatches = [...cleaned.matchAll(/"options"\s*:\s*\[((?:[^\]]|\\.)*)\]/gi)];
  const answerMatches = [...cleaned.matchAll(/"answer"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|\[((?:[^\]]|\\.)*)\])/gi)];

  const objects: any[] = [];

  for (const questionMatch of questionMatches) {
    const question = questionMatch[1].replace(/\\"/g, '"').trim();
    const questionIndex = questionMatch.index ?? 0;
    if (!question) continue;

    const optionsEntry = optionsMatches.find((entry) => (entry.index ?? 0) > questionIndex);
    const answerEntry = answerMatches.find((entry) => (entry.index ?? 0) > questionIndex);

    const options = optionsEntry ? extractQuotedStrings(optionsEntry[1]) : [];
    let answer = answerEntry?.[1] ? answerEntry[1].replace(/\\"/g, '"').trim() : undefined;

    if (!answer && answerEntry?.[2]) {
      const arrayText = answerEntry[2];
      const arrayOptions = extractQuotedStrings(arrayText);
      answer = arrayOptions[0]?.trim();
    }

    if (options.length === 0) continue;

    const normalizedOptions = options.slice(0, 3);
    const normalizedAnswer = answer && normalizedOptions.includes(answer)
      ? answer
      : normalizedOptions[0];

    objects.push({
      question,
      options: normalizedOptions,
      answer: normalizedAnswer,
    });
  }

  return objects;
}

function safeParseQuiz(cleanedQuiz: string) {
  try {
    return JSON.parse(cleanedQuiz);
  } catch (error) {
    const repaired = repairQuizJson(cleanedQuiz);
    const arrayText = extractFirstJsonArray(repaired) || extractFirstJsonArray(cleanedQuiz);

    if (arrayText) {
      try {
        return JSON.parse(arrayText);
      } catch (arrayError) {
        console.error("[quiz] extractFirstJsonArray parse failed:", arrayError, "arrayText:", arrayText);
      }
    }

    try {
      return JSON.parse(repaired);
    } catch (repairError) {
      console.error("[quiz] repair parse failed:", repairError, "repaired:", repaired);
      const manual = parseQuizArrayManually(repaired);
      if (manual.length > 0) {
        return manual;
      }
      const manualOriginal = parseQuizArrayManually(cleanedQuiz);
      return manualOriginal.length > 0 ? manualOriginal : null;
    }
  }
}

function normalizeRawQuiz(raw: string) {
  return raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/"""/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRawQuiz(raw: string) {
  let cleaned = normalizeRawQuiz(raw);
  const arrayStart = cleaned.indexOf("[");
  if (arrayStart !== -1) {
    cleaned = cleaned.substring(arrayStart);
  }

  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayEnd !== -1) {
    cleaned = cleaned.substring(0, arrayEnd + 1);
  }

  return cleaned;
}

function buildQuizRetryPrompt(raw: string, context: string, topic: string, age: number) {
  return `The previous response was invalid. Extract ONLY the valid JSON array below, with exactly 3 objects and no extra text.

Invalid response:
${raw}

Return EXACTLY one JSON array only:
[
  {"question":"...","options":["...","...","..."],"answer":"..."},
  {"question":"...","options":["...","...","..."],"answer":"..."},
  {"question":"...","options":["...","...","..."],"answer":"..."}
]

No markdown, no comments, no backticks, no extra text.
Each answer must be a single string matching one of the options.
If you cannot produce valid JSON, return [].`;
}

function defaultQuizForTopic(topic: string) {
  const safeTopic = typeof topic === "string" && topic.trim() ? topic.trim().replace(/"/g, "'") : "this topic";
  return [
    {
      question: `What is the main subject of this quiz?`,
      options: [safeTopic, "A different subject", "I don't know"],
      answer: safeTopic,
    },
    {
      question: `Which topic is this quiz about?`,
      options: [safeTopic, "Another topic", "Something else"],
      answer: safeTopic,
    },
    {
      question: `What was this quiz intended to teach?`,
      options: [safeTopic, "History", "Math"],
      answer: safeTopic,
    },
  ];
}

function buildQuizPrompt(
  context: string,
  topic: string,
  age: number
) {
  return `You are a quiz creator for a ${age}-year-old child.

Output must be valid JSON only. Do not include any markdown, explanation, or extra text.

Return EXACTLY one JSON array. It must start with '[' and end with ']'.
Do not return anything else.

The array must contain exactly 3 objects. Each object must contain only these keys:
- question
- options
- answer

The question value must be a string.
The options value must be an array of exactly 3 strings.
The answer value must be a single string exactly matching one of the options.
Do not use an array for answer.

Example output exactly:
[{"question":"What do dinosaurs eat?","options":["Plants","Meat","Ice cream"],"answer":"Meat"},{"question":"When did dinosaurs live?","options":["100 years ago","1 million years ago","65 million years ago"],"answer":"65 million years ago"},{"question":"How big was a T-Rex?","options":["Small like a cat","Big like a bus","Huge like a mountain"],"answer":"Big like a bus"}]

Rules:
- Exactly 3 questions.
- Exactly 3 options per question.
- answer must exactly match one of the 3 options.
- No extra keys, no reason, no explanation, no comments.
- No trailing commas.
- No nested arrays except the options array.
- No unescaped newlines inside string values.

CONTEXT:
${context}

NOW create 3 quiz questions about ${topic}:`;
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
            let parsed = safeParseQuiz(cleanedQuiz);
            if (parsed) {
              parsed = fixQuizAnswers(parsed);
              cleanedQuiz = JSON.stringify(parsed);
            } else {
              console.error("[quiz] streaming parse failed, raw:", cleanedQuiz);
            }
          } catch (e) {
            console.error("[quiz] streaming parse error:", e, "raw:", cleanedQuiz);
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

  let cleanedQuiz = cleanRawQuiz(quiz);
  let parsed = safeParseQuiz(cleanedQuiz);

  if (!parsed) {
    console.log("[quiz] first parse failed, retrying with a stricter prompt");
    const retryPrompt = buildQuizRetryPrompt(quiz, context, topic, age);
    const retryResponse = await generateAnswer(retryPrompt, 2000);
    const retryCleaned = cleanRawQuiz(retryResponse);
    parsed = safeParseQuiz(retryCleaned);
    if (!parsed) {
      console.error("[quiz] retry parse also failed", retryCleaned);
      parsed = defaultQuizForTopic(topic);
    }
  }

  parsed = fixQuizAnswers(parsed);

  if (!validateQuizFormat(parsed)) {
    console.error("[quiz] Invalid quiz format after fixes:", JSON.stringify(parsed));
    parsed = defaultQuizForTopic(topic);
  }

  const totalTime = Date.now() - startTime;
  console.log(`[quiz] Total time: ${totalTime}ms (retrieval: ${retrievalTime}ms, LLM: ${llmTime}ms)`);
  return NextResponse.json({ quiz: JSON.stringify(parsed), _timing: { totalTime, retrievalTime, llmTime } });
}