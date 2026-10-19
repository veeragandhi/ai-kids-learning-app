import { NextResponse } from "next/server";
import { deleteChunksByDocument } from "@/lib/vectorStore";
import {
  docDisplayName,
  getDocuments,
  readDocumentText,
  resolveDocPath,
  saveDocuments,
  type DocumentItem,
} from "@/lib/documents";
import { finalizeDocumentText } from "@/lib/ingest";
import { verifyChildOwnership } from "@/lib/supabase/requireChild";
import fs from "fs";
import path from "path";

const uploadDir = path.join(process.cwd(), "uploads");

// GET ?childId= → { owned, legacy }. Verified before any listing.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const childId = url.searchParams.get("childId");
  const verified = await verifyChildOwnership(req, childId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  const all = getDocuments();
  const owned = all.filter((doc) => doc.childId === verified.childId);
  // Legacy docs are read-only: listed for the badge + explicit import only,
  // never implicitly in the child's retrieval scope (see lib/retrieval.ts).
  // Privacy (Stage 5): the pre-profile namespace has no owner, so its titles
  // are disclosed only in demo/local mode. Authenticated callers from another
  // family on a shared device must not enumerate them. Nothing is deleted.
  const legacy =
    verified.mode === "demo" ? all.filter((doc) => doc.legacy) : [];
  return NextResponse.json({ owned, legacy });
}

// TOGGLE APPROVAL — owned documents only.
export async function PATCH(req: Request) {
  const body = await req.json();

  const { name } = body;

  const verified = await verifyChildOwnership(req, body.childId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  const documents = getDocuments();
  const target = documents.find((doc) => doc.name === name);
  if (!target) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  if (target.legacy || target.childId !== verified.childId) {
    // Same response for missing vs foreign — no oracle for guessing names.
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const updated = documents.map((doc) => {
    if (doc.name === name) {
      return {
        ...doc,
        approved: !doc.approved
      };
    }

    return doc;
  });

  saveDocuments(updated);

  return NextResponse.json(updated.filter((doc) => doc.childId === verified.childId));
}

// IMPORT — copy a legacy/shared document into the verified child's namespace.
// Creates child-scoped file + chunks; the original is left untouched.
export async function POST(req: Request) {
  const body = await req.json();
  const { name } = body;

  const verified = await verifyChildOwnership(req, body.childId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  if (typeof name !== "string" || name.length === 0) {
    return NextResponse.json(
      { error: "A document name is required" },
      { status: 400 }
    );
  }

  const documents = getDocuments();
  const target = documents.find((doc) => doc.name === name);
  // Privacy (Stage 5): legacy import is a demo/local-mode workflow. In
  // authenticated mode the pre-profile namespace is not disclosed (see GET),
  // so guessing a legacy name here must not yield its content either.
  // Uniform 404 — no oracle for name guessing. Nothing is deleted.
  if (!target || !target.legacy || verified.mode !== "demo") {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const text = readDocumentText(target.name);
  if (!text) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const base = docDisplayName(target);
  const { name: relName } = await finalizeDocumentText(base, text, "text", {
    childId: verified.childId,
  });
  const updated = getDocuments();
  return NextResponse.json({
    success: true,
    name: relName,
    documents: updated.filter((doc) => doc.childId === verified.childId),
  });
}

// DELETE DOC — owned documents only.
export async function DELETE(req: Request) {
  const body = await req.json();

  const { name } = body;

  const verified = await verifyChildOwnership(req, body.childId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  if (typeof name !== "string" || name.length === 0) {
    return NextResponse.json(
      { error: "A document name is required" },
      { status: 400 }
    );
  }

  const documents: DocumentItem[] = getDocuments();

  // P-1: whitelist — the name must exactly match a known, already-tracked
  // document. This is the primary defense: an attacker-supplied name like
  // "../../.env" or "../app/globals.css" simply won't be in this list.
  const target = documents.find((doc) => doc.name === name);

  if (!target) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  if (target.legacy || target.childId !== verified.childId) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  // Ownership-scoped path: resolveDocPath enforces containment; the metadata
  // whitelist above already pinned the exact relative path.
  const resolvedFilePath = resolveDocPath(target.name);
  if (!resolvedFilePath) {
    console.error(`[documents] Rejected unsafe delete path: ${name}`);
    return NextResponse.json(
      { error: "Invalid document name" },
      { status: 400 }
    );
  }

  const filtered = documents.filter(
    (doc) => doc.name !== name
  );

  saveDocuments(filtered);

  // Delete embeddings from vector store (this child's namespace only)
  deleteChunksByDocument(name, verified.childId);

  if (fs.existsSync(resolvedFilePath)) {
    // Final containment re-check against the child namespace + uploads root.
    const resolvedUploadDir = path.resolve(uploadDir) + path.sep;
    if (!resolvedFilePath.startsWith(resolvedUploadDir)) {
      console.error(`[documents] Rejected unsafe delete path: ${name}`);
      return NextResponse.json(
        { error: "Invalid document name" },
        { status: 400 }
      );
    }
    fs.unlinkSync(resolvedFilePath);
  }

  console.log(`[documents] Deleted document: ${name}`);
  return NextResponse.json(filtered.filter((doc) => doc.childId === verified.childId));
}
