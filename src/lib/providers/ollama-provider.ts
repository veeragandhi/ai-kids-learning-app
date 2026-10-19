import { AIProvider, ChatMessage, ChatOptions } from "./types";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_MODEL || "gemma3:1b";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "gemma3:4b";

function messagesToPrompt(messages: ChatMessage[]): string {
  let prompt = "";
  for (const msg of messages) {
    if (msg.role === "system") {
      prompt += `System: ${msg.content}\n\n`;
    } else if (msg.role === "user") {
      prompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === "assistant") {
      prompt += `Assistant: ${msg.content}\n\n`;
    }
  }
  prompt += "Assistant: ";
  return prompt;
}

export class OllamaProvider implements AIProvider {
  name = "ollama";
  model = OLLAMA_CHAT_MODEL;
  embedModel = OLLAMA_EMBED_MODEL;
  visionModel = OLLAMA_VISION_MODEL;

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const prompt = messagesToPrompt(messages);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 300,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama responded with status ${res.status}`);
    }
    const data = await res.json();
    if (!data.response) throw new Error("Ollama returned no response");
    return data.response;
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    const prompt = messagesToPrompt(messages);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: true,
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 2000,
      }),
    });

    if (!res.ok) throw new Error(`Ollama responded with status ${res.status}`);
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
          if (line) {
            try {
              const json = JSON.parse(line);
              if (json.response) yield json.response;
            } catch {}
          }
        }
        buffer = lines[lines.length - 1];
      }
      if (buffer.trim()) {
        try {
          const json = JSON.parse(buffer);
          if (json.response) yield json.response;
        } catch {}
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.embedModel, prompt: text }),
    });
    if (!res.ok) throw new Error(`Failed to create embedding: ${res.status}`);
    const data = await res.json();
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error("Invalid embedding response");
    }
    return data.embedding;
  }
}
