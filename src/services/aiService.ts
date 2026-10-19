import { AIProvider, ChatMessage, ChatOptions, EngineMode } from "@/lib/providers/types";
import { OllamaProvider } from "@/lib/providers/ollama-provider";
import { GeminiProvider } from "@/lib/providers/gemini-provider";

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function getEngineMode(): EngineMode {
  const mode = process.env.AI_ENGINE || "auto";
  if (mode === "ollama" || mode === "hosted" || mode === "auto") return mode as EngineMode;
  return "auto";
}

export class AIService {
  private provider: AIProvider;

  constructor() {
    this.provider = this.selectProvider();
  }

  private selectProvider(): AIProvider {
    const mode = getEngineMode();
    const inTauri = isTauriRuntime();

    if (inTauri || mode === "ollama") {
      return new OllamaProvider();
    }

    if (mode === "hosted") {
      return new GeminiProvider();
    }

    // auto mode
    // Default to gemini for web if not in tauri (ollama preferred when
    // available — callers select explicitly via mode, see getEngineMode).
    return new GeminiProvider();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return this.provider.chat(messages, options);
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    yield* this.provider.chatStream(messages, options);
  }

  async embed(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }

  getProviderName(): string {
    return this.provider.name;
  }
}

export const aiService = new AIService();
