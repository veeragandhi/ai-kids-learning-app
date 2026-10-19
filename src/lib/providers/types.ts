export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface EmbeddingOptions {
  dimensions?: number;
}

export interface AIProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string, void, unknown>;
  embed(text: string, options?: EmbeddingOptions): Promise<number[]>;
  isAvailable(): Promise<boolean>;
}

export type EngineMode = "auto" | "ollama" | "hosted";
