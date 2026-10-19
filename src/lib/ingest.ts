// lib/ingest.ts — single embed path shared by direct + confirmed OCR uploads.
// finalizeDocumentText() saves .txt, registers the doc, chunks, embeds.
// Upload route stays thin; confirm route reuses this after parent approval.
//
// Idempotent + rollback-safe (Stage 3): all fallible external work
// (normalization is pure; embeddings hit Ollama) completes BEFORE any
// mutation, so a failed replacement never destroys the previous valid
// document. Re-ingesting the same (document, child) replaces its chunks
// instead of stacking duplicates.

import {
  addDocument,
  getDocuments,
  readDocumentText,
  resolveDocPath,
  saveDocuments,
  saveTextDocument,
} from "@/lib/documents";
import {
  addChunks,
  deleteChunksByDocument,
  getChunks,
} from "@/lib/vectorStore";
import { chunkText } from "@/lib/chunk";
import { createEmbedding } from "@/lib/embeddings";
import { normalizeWorksheetText } from "@/lib/ocr";
import { v4 as uuid } from "uuid";
import type { OcrSource } from "@/lib/ocr-jobs";
import fs from "fs";

import path from "path";

export type FinalizeOptions = {
  /**
   * Verified owner child id. Required for new uploads; when omitted the
   * document is stored as legacy (top-level, shared, never implicitly in a
   * child's retrieval scope). Callers must pass the verified id, never raw
   * client input.
   */
  childId?: string | null;
};

export async function finalizeDocumentText(
  textFileName: string,
  text: string,
  source: OcrSource = "text",
  opts: FinalizeOptions = {}
): Promise<{ chunks: number; name: string }> {
  // Single normalization boundary for every ingest path (direct txt, PDF
  // text layer, approved OCR): canonical [BLANK], transcription preambles
  // and echoed OCR lines are removed before anything is chunked or embedded.
  const normalized = normalizeWorksheetText(text);
  // Namespace by child to prevent cross-child filename collisions and
  // guessing: `uploads/<childId>/<base>.txt`. Legacy (no childId) stays
  // top-level for backward compatibility + explicit import flows.
  const base = path.basename(textFileName);
  const childId = opts.childId ?? null;
  const relName =
    childId && childId === path.basename(childId)
      ? `${childId}/${base}`
      : base;

  // Snapshot for rollback (previous valid state, if any).
  const prevText = readDocumentText(relName);
  const hadFile = prevText !== null;
  const prevDocs = getDocuments();
  const prevChunks = getChunks().filter(
    (c) => c.documentName === relName && (c.childId ?? null) === childId
  );

  // Phase 1 — fallible external work first (Ollama embeddings). Nothing is
  // mutated yet, so an Ollama outage leaves zero misleading metadata/files.
  const chunks = chunkText(normalized);
  const vectors = await Promise.all(
    chunks.map(async (chunk) => ({
      id: uuid(),
      text: chunk,
      embedding: await createEmbedding(chunk),
      documentName: relName,
      childId,
    }))
  );

  // Phase 2 — commit (local FS writes; rollback best-effort on failure).
  try {
    saveTextDocument(relName, normalized);
    addDocument(relName, { childId });
    // Idempotent replacement: drop this document+child's old chunks before
    // adding the new ones (sibling namespaces sharing a basename untouched).
    deleteChunksByDocument(relName, childId);
    addChunks(vectors);
  } catch (commitError) {
    try {
      if (!hadFile) {
        const resolved = resolveDocPath(relName);
        if (resolved && fs.existsSync(resolved)) fs.unlinkSync(resolved);
        saveDocuments(prevDocs);
      } else {
        saveTextDocument(relName, prevText as string);
        saveDocuments(prevDocs);
      }
      // Restore replaced chunks (delete-then-add above may have run).
      const current = getChunks().filter(
        (c) => c.documentName === relName && (c.childId ?? null) === childId
      );
      if (current.length === 0 && prevChunks.length > 0) addChunks(prevChunks);
    } catch {
      // Rollback itself is best-effort; the original error still throws.
    }
    throw commitError;
  }
  console.log(`[ingest] ${relName} source=${source} chunks=${chunks.length}`);
  return { chunks: chunks.length, name: relName };
}
