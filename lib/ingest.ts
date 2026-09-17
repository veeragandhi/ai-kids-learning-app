// lib/ingest.ts — single embed path shared by direct + confirmed OCR uploads.
// finalizeDocumentText() saves .txt, registers the doc, chunks, embeds.
// Upload route stays thin; confirm route reuses this after parent approval.

import { addDocument, saveTextDocument } from "@/lib/documents";
import { addChunks } from "@/lib/vectorStore";
import { chunkText } from "@/lib/chunk";
import { createEmbedding } from "@/lib/embeddings";
import { v4 as uuid } from "uuid";
import type { OcrSource } from "@/lib/ocr-jobs";

export async function finalizeDocumentText(
  textFileName: string,
  text: string,
  source: OcrSource = "text"
): Promise<{ chunks: number }> {
  saveTextDocument(textFileName, text);
  addDocument(textFileName);
  const chunks = chunkText(text);
  const vectors = await Promise.all(
    chunks.map(async (chunk) => ({
      id: uuid(),
      text: chunk,
      embedding: await createEmbedding(chunk),
      documentName: textFileName,
    }))
  );
  addChunks(vectors);
  console.log(`[ingest] ${textFileName} source=${source} chunks=${chunks.length}`);
  return { chunks: chunks.length };
}
