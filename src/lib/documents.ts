import fs from "fs";
import path from "path";

export type DocumentItem = {
  /**
   * Relative path within `uploads/` (e.g. `Elephants.txt` for legacy,
   * `demo-local/Elephants.txt` or `<uuid>/Elephants.txt` for child-owned).
   * Never an absolute path; path guards enforce containment.
   */
  name: string;
  approved: boolean;
  /** Owner child id, or `null` for pre-isolation legacy documents. */
  childId: string | null;
  /** True for documents created before child profiles (top-level, shared). */
  legacy: boolean;
};

const uploadDir = path.join(
  process.cwd(),
  "uploads"
);

const metadataPath = path.join(
  uploadDir,
  "documents.json"
);

/** Display basename for UI (no directory components). */
export function docDisplayName(doc: Pick<DocumentItem, "name">): string {
  return path.basename(doc.name);
}

/**
 * Resolve a metadata `name` to an absolute path, enforcing containment
 * inside `uploadDir`. Returns `null` for unsafe values (traversal, absolute).
 */
export function resolveDocPath(relName: string): string | null {
  if (typeof relName !== "string" || relName.length === 0) return null;
  const safeRel = relName
    .split("/")
    .map((seg) => path.basename(seg))
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join(path.sep);
  if (!safeRel) return null;
  const resolvedUploadDir = path.resolve(uploadDir) + path.sep;
  const resolved = path.resolve(uploadDir, safeRel);
  if (!resolved.startsWith(resolvedUploadDir)) return null;
  // The normalized relative path must round-trip: rejects `..`, absolute
  // paths, and empty segments smuggled through the metadata file.
  const roundTrip = path.relative(path.resolve(uploadDir), resolved);
  if (roundTrip !== relName.split("/").join(path.sep)) return null;
  return resolved;
}

/** Normalize a raw metadata array (legacy entries lack new fields). */
export function normalizeDocuments(raw: unknown): DocumentItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
    .map((d) => {
      const name = typeof d.name === "string" ? d.name : "";
      const childId = typeof d.childId === "string" ? d.childId : null;
      const legacy = typeof d.legacy === "boolean" ? d.legacy : childId === null;
      return {
        name,
        approved: d.approved !== false,
        childId,
        legacy,
      };
    })
    .filter((d) => d.name.length > 0 && resolveDocPath(d.name) !== null);
}

export function getApprovedDocumentText() {

  const uploadDir = path.join(
    process.cwd(),
    "uploads"
  );

  const metadataPath = path.join(
    uploadDir,
    "documents.json"
  );

  let documentText = "";

  if (
    fs.existsSync(uploadDir) &&
    fs.existsSync(metadataPath)
  ) {

    // NOTE: legacy helper kept for non-personalized callers only. It reads
    // every approved doc and must NOT feed personalized lesson/quiz/ask
    // prompts (those go through child-scoped retrieval). Path-guarded.
    const documents = normalizeDocuments(JSON.parse(
      fs.readFileSync(metadataPath, "utf-8")
    ));

    const approvedDocs = documents.filter(
      (doc) => doc.approved
    );

    approvedDocs.forEach((doc) => {

      const resolved = resolveDocPath(doc.name);
      if (!resolved || !fs.existsSync(resolved)) return;

      const content = fs.readFileSync(
        resolved,
        "utf-8"
      );

      documentText += content + "\n";
    });
  }

  return documentText;
}

/** Read one owned document's text (guarded). Null when missing/unsafe. */
export function readDocumentText(relName: string): string | null {
  const resolved = resolveDocPath(relName);
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch {
    return null;
  }
}

export function saveTextDocument(
  fileName: string,
  text: string
) {

  const resolved = resolveDocPath(fileName);
  if (!resolved) {
    throw new Error("Refusing to write outside the uploads directory");
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  fs.writeFileSync(resolved, text);
}

export function getDocuments(): DocumentItem[] {

  if (!fs.existsSync(metadataPath)) {
    return [];
  }

  return normalizeDocuments(JSON.parse(
    fs.readFileSync(metadataPath, "utf-8")
  ));
}

export function saveDocuments(
  documents: DocumentItem[]
) {

  fs.writeFileSync(
    metadataPath,
    JSON.stringify(documents, null, 2)
  );
}

export function addDocument(
  fileName: string,
  opts: { childId?: string | null } = {}
) {

  const documents = getDocuments();

  const exists = documents.find(
    (d) => d.name === fileName
  );

  if (!exists) {
    const childId = opts.childId ?? null;

    documents.push({
      name: fileName,
      approved: true,
      childId,
      legacy: childId === null,
    });

    saveDocuments(documents);
  }
}
