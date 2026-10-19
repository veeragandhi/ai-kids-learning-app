import { AIProvider, ChatMessage, ChatOptions } from "./types";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";
const GEMINI_EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "text-embedding-004";

function messagesToGemini(messages: ChatMessage[]) {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      // Include system as user preface or skip - Gemini uses different system handling
      contents.push({ role: "user", parts: [{ text: `System: ${msg.content}` }] });
      contents.push({ role: "model", parts: [{ text: "Understood." }] });
    } else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
  }
  return contents;
}

export class GeminiProvider implements AIProvider {
  name = "gemini";
  model = GEMINI_CHAT_MODEL;
  embedModel = GEMINI_EMBED_MODEL;

  async isAvailable(): Promise<boolean> {
    return !!GEMINI_API_KEY;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
    const contents = messagesToGemini(messages);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 300,
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini responded with status ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no response");
    return text;
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
    const contents = messagesToGemini(messages);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 2000,
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini responded with status ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") return;
            try {
              const json = JSON.parse(data);
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) yield text;
            } catch {}
          }
        }
        buffer = lines[lines.length - 1];
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.embedModel}:embedContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${this.embedModel}`,
        content: { parts: [{ text }] },
      }),
    });
    if (!res.ok) throw new Error(`Gemini embedding failed: ${res.status}`);
    const data = await res.json();
    const embedding = data.embedding?.values;
    if (!Array.isArray(embedding)) throw new Error("Invalid Gemini embedding");
    return embedding;
  }
}
