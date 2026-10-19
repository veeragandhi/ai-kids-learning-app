import { NextResponse } from "next/server";
import { OllamaProvider } from "@/lib/providers/ollama-provider";

// Local-only AI (Stage 4): children's chat runs on on-device Ollama ONLY.
// This route deliberately does NOT use `aiService`: its auto mode selects the
// hosted Gemini provider on web, which would send kids' prompts off-device.
// Ollama failures return 503 with a clear message — never a silent switch.
const ollama = new OllamaProvider();

function unavailable(): NextResponse {
  return NextResponse.json(
    {
      error:
        "The on-device AI is unavailable. Please start Ollama and try again.",
    },
    { status: 503 }
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages = body.messages || [];
    const stream = body.stream || false;
    const temperature = body.temperature ?? 0.2;
    const maxTokens = body.maxTokens ?? 300;

    if (!(await ollama.isAvailable())) {
      console.error("[chat] Ollama unavailable, refusing hosted fallback");
      return unavailable();
    }

    if (stream) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of ollama.chatStream(messages, { temperature, maxTokens })) {
              controller.enqueue(encoder.encode(chunk));
            }
          } catch (error) {
            console.error("[chat] stream error:", error);
          } finally {
            controller.close();
          }
        },
      });
      return new Response(readable, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Transfer-Encoding": "chunked",
        },
      });
    }

    try {
      const response = await ollama.chat(messages, { temperature, maxTokens });
      return NextResponse.json({ response });
    } catch (error) {
      console.error("[chat] error:", error);
      return unavailable();
    }
  } catch (error) {
    console.error("[chat] error:", error);
    return NextResponse.json({ error: "Chat failed" }, { status: 500 });
  }
}
