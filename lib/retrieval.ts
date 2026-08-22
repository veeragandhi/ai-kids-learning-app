import { createEmbedding } from "./embeddings";
import { getChunks } from "./vectorStore";

function cosineSimilarity(
  a: number[],
  b: number[]
) {
   if (a.length !== b.length) {
    throw new Error(
      "Embedding dimensions mismatch"
    );
  }
  
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return (
    dot /
    (Math.sqrt(normA) * Math.sqrt(normB))
  );
}

function hasQueryAnchors(query: string, context: string) {
  const ignored = new Set([
    "a", "an", "and", "are", "as", "at", "can", "could", "did", "do", "does", "for", "how",
    "in", "is", "it", "of", "on", "or", "the", "to", "was", "were", "what", "when", "where",
    "which", "who", "why", "with", "alike", "different", "need", "needs", "use", "uses",
  ]);
  const queryWords = (query.toLowerCase().match(/[a-z]+/g) || [])
    .filter((word) => !ignored.has(word))
    .map((word) => word.replace(/(ing|ed|s)$/, ""));
  const contextWords = new Set(
    (context.toLowerCase().match(/[a-z]+/g) || []).map((word) => word.replace(/(ing|ed|s)$/, ""))
  );

  return queryWords.length > 0 && queryWords.every((word) => contextWords.has(word));
}

export async function 
getRelevantContext(
  query: string,
  topK = 3,
  minSimilarity = 0.50
) {
  try {
    const queryEmbedding =
      await createEmbedding(query);

    const chunks = getChunks();
    console.log("[retrieval] total chunks in store:", chunks.length);

    const scored = chunks.map(
      (chunk) => ({
        text: chunk.text,
        document: chunk.documentName || "unknown",
        score: cosineSimilarity(
          queryEmbedding,
          chunk.embedding
        ),
      })
    );

    scored.sort((a, b) => b.score - a.score);

    console.log("[retrieval] top 5 scores for query '" + query + "':");
    scored.slice(0, 5).forEach((s, i) => {
      console.log(`  ${i+1}. score: ${s.score.toFixed(3)}, doc: ${s.document}, text: "${s.text.substring(0, 60)}..."`);
    });

    // Filter by minimum similarity threshold
    const filtered = scored
      .filter((x) => x.score >= minSimilarity)
      .slice(0, topK);

    const context = filtered
      .map((x) => x.text)
      .join("\n");

    console.log("[retrieval] query:", query, "found:", filtered.length, "chunks with score >= " + minSimilarity);
    
    if (filtered.length === 0 || !hasQueryAnchors(query, context)) {
      console.log("[retrieval] no relevant documents found");
      return "";
    }

    const result = context;
    
    console.log("[retrieval] retrieved context, length:", result.length);
    return result;
  } catch (error) {
    console.error("[retrieval] error:", error);
    throw error;
  }
}