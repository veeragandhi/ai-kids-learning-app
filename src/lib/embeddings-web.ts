import { aiService } from "@/services/aiService";

export async function createEmbeddingWeb(text: string): Promise<number[]> {
  return await aiService.embed(text);
}
