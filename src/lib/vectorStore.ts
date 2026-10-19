// lib/vectorStore.ts

import fs from "fs";
import path from "path";

export type VectorDocumentChunk = {
  id: string;
  text: string;
  embedding: number[];
  documentName?: string; // Track which document this chunk came from
  /**
   * Owner child id (Supabase `children.id` UUID or `demo-local`).
   * Missing/undefined = legacy chunk written before per-child isolation;
   * retrieval treats it as `null` (legacy/shared) and never includes it in a
   * child's personalized context implicitly.
   */
  childId?: string | null;
};

const embeddingsDir = path.join(
  process.cwd(),
  "embeddings"
);

const vectorFile = path.join(
  embeddingsDir,
  "vectors.json"
);

// Create embeddings folder if it doesn't exist
if (!fs.existsSync(embeddingsDir)) {
  fs.mkdirSync(embeddingsDir, {
    recursive: true,
  });
}

// Create vectors.json if it doesn't exist
if (!fs.existsSync(vectorFile)) {
  fs.writeFileSync(
    vectorFile,
    JSON.stringify([], null, 2)
  );
}

/**
 * Save new chunks permanently
 */
export function addChunks(
  newChunks: VectorDocumentChunk[]
) {
  try {
    // Read existing chunks
    const existingChunks = getChunks();

    // Merge old + new
    const updatedChunks = [
      ...existingChunks,
      ...newChunks,
    ];

    // Save back to file
    fs.writeFileSync(
      vectorFile,
      JSON.stringify(updatedChunks, null, 2),
      "utf-8"
    );

    console.log(
      `Saved ${newChunks.length} chunks`
    );
  } catch (error) {
    console.error(
      "Failed to save embeddings:",
      error
    );
  }
}

/**
 * Load all chunks from vectors.json
 */
export function getChunks(): VectorDocumentChunk[] {
  try {
    const data = fs.readFileSync(
      vectorFile,
      "utf-8"
    );

    return JSON.parse(data);
  } catch (error) {
    console.error(
      "Failed to load embeddings:",
      error
    );

    return [];
  }
}

/**
 * Delete chunks by document name
 * When `childId` is given, only that child's chunks are removed (sibling
 * namespaces sharing a basename are untouched).
 */
export function deleteChunksByDocument(
  documentName: string,
  childId?: string | null
) {
  try {
    const existingChunks = getChunks();

    // Filter out chunks from this document
    const filteredChunks = existingChunks.filter(
      (chunk) =>
        chunk.documentName !== documentName ||
        (childId !== undefined && (chunk.childId ?? null) !== childId)
    );

    // Save back to file
    fs.writeFileSync(
      vectorFile,
      JSON.stringify(filteredChunks, null, 2),
      "utf-8"
    );

    const deletedCount = existingChunks.length - filteredChunks.length;
    console.log(
      `Deleted ${deletedCount} chunks for document: ${documentName}`
    );
  } catch (error) {
    console.error(
      "Failed to delete embeddings:",
      error
    );
  }
}