import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const uploadsDir = path.join(root, "uploads");
const vectorsPath = path.join(root, "embeddings", "vectors.json");

function chunkText(text, chunkSize = 500, overlap = 100) {
  const words = text.split(/\s+/);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
    i += chunkSize - overlap;
  }
  return chunks;
}

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

async function createEmbedding(text) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error("Invalid embedding response");
  }
  return data.embedding;
}

const files = (await readdir(uploadsDir)).filter((name) => name.endsWith(".txt"));
const chunks = [];

for (const fileName of files) {
  const text = await readFile(path.join(uploadsDir, fileName), "utf8");
  const textChunks = chunkText(text);
  console.log(`Indexing ${fileName}: ${textChunks.length} chunks`);
  for (const chunk of textChunks) {
    chunks.push({
      id: randomUUID(),
      text: chunk,
      embedding: await createEmbedding(chunk),
      documentName: fileName,
    });
  }
}

await writeFile(vectorsPath, JSON.stringify(chunks, null, 2), "utf8");
console.log(`Wrote ${chunks.length} chunks to embeddings/vectors.json`);
