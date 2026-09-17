import { createEmbedding } from "./embeddings";
import { getChunks } from "./vectorStore";

const IGNORED_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "can", "could", "did", "do",
  "does", "for", "from", "give", "how", "in", "is", "it", "just", "me", "of", "on",
  "or", "please", "tell", "the", "their", "them", "then", "there", "they", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "why", "with",
  "you", "your", "alike", "different", "need", "needs", "use", "uses", "using",
]);

const ATTRIBUTE_WORDS = new Set([
  "color", "colour", "favorite", "favourite", "age", "name", "names",
]);

export function stemWord(word: string) {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function contentTokens(text: string) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((word) => word.length > 1 && !IGNORED_WORDS.has(word))
    .map(stemWord);
}

export function cleanRetrievalQuery(query: string) {
  return query
    .replace(/\bjust tell me:?\s*/gi, "")
    .replace(/\b(tell me the answer|give me the answer|what is the answer)\b:?\s*/gi, "")
    .trim();
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) {
    throw new Error("Embedding dimensions mismatch");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function lexicalOverlap(queryTokens: string[], text: string) {
  if (queryTokens.length === 0) return 0;
  const contextTokens = new Set(contentTokens(text));
  const hits = queryTokens.filter((token) => contextTokens.has(token)).length;
  return hits / queryTokens.length;
}

function contextSupportsQuery(query: string, context: string) {
  const queryTokens = contentTokens(query);
  if (queryTokens.length === 0 || !context.trim()) return false;

  const contextTokens = new Set(contentTokens(context));
  const hits = queryTokens.filter((token) => contextTokens.has(token));
  const missing = queryTokens.filter((token) => !contextTokens.has(token));

  if (hits.length === 0) return false;

  const missingAttributes = missing.filter((token) => ATTRIBUTE_WORDS.has(token));
  if (missingAttributes.length > 0) return false;

  const distinctiveHits = hits.filter((token) => token.length >= 3);
  const overlap = hits.length / queryTokens.length;

  // More lenient overlap for age-related queries
  const minOverlap = queryTokens.length > 0 ? 0.2 : 0.1;
  return overlap >= minOverlap || distinctiveHits.length >= 1;
}

export async function getRelevantContext(
  query: string,
  topK = 3,
  minSimilarity = 0.50
) {
  try {
    const retrievalQuery = cleanRetrievalQuery(query);
    const queryTokens = contentTokens(retrievalQuery);
    const queryEmbedding = await createEmbedding(retrievalQuery);
    const chunks = getChunks();
    console.log("[retrieval] total chunks in store:", chunks.length);

    const scored = chunks.map((chunk) => {
      const cosine = cosineSimilarity(queryEmbedding, chunk.embedding);
      const lexical = lexicalOverlap(queryTokens, chunk.text);
      return {
        text: chunk.text,
        document: chunk.documentName || "unknown",
        cosine,
        lexical,
        score: 0.7 * cosine + 0.3 * lexical,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    console.log("[retrieval] top 5 hybrid scores for query '" + retrievalQuery + "':");
    scored.slice(0, 5).forEach((item, index) => {
      console.log(
        `  ${index + 1}. hybrid: ${item.score.toFixed(3)} cosine: ${item.cosine.toFixed(3)} lexical: ${item.lexical.toFixed(3)} doc: ${item.document} text: "${item.text.substring(0, 60)}..."`
      );
    });

    const filtered = scored
      .filter((item) => item.cosine >= minSimilarity && item.lexical > 0)
      .slice(0, topK);

    const context = filtered.map((item) => item.text).join("\n");

    console.log(
      "[retrieval] query:",
      retrievalQuery,
      "found:",
      filtered.length,
      "chunks with cosine >= " + minSimilarity
    );

    if (filtered.length === 0 || !contextSupportsQuery(retrievalQuery, context)) {
      console.log("[retrieval] no relevant documents found");
      return "";
    }

    console.log("[retrieval] retrieved context, length:", context.length);
    return context;
  } catch (error) {
    console.error("[retrieval] error:", error);
    throw error;
  }
}
