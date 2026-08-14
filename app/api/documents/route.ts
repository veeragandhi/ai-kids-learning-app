import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { deleteChunksByDocument } from "@/lib/vectorStore";

type DocumentItem = {
  name: string;
  approved: boolean;
};

const uploadDir = path.join(process.cwd(), "uploads");
const metadataPath = path.join(uploadDir, "documents.json");

function readDocuments(): DocumentItem[] {
  if (!fs.existsSync(metadataPath)) {
    return [];
  }

  return JSON.parse(
    fs.readFileSync(metadataPath, "utf-8")
  );
}

function saveDocuments(documents: DocumentItem[]) {
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(documents, null, 2)
  );
}

// GET all docs
export async function GET() {
  return NextResponse.json(readDocuments());
}

// TOGGLE APPROVAL
export async function PATCH(req: Request) {
  const body = await req.json();

  const { name } = body;

  const documents = readDocuments();

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

  return NextResponse.json(updated);
}

// DELETE DOC
export async function DELETE(req: Request) {
  const body = await req.json();

  const { name } = body;

  if (typeof name !== "string" || name.length === 0) {
    return NextResponse.json(
      { error: "A document name is required" },
      { status: 400 }
    );
  }

  const documents = readDocuments();

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

  // P-1: defense in depth — even for a whitelisted name, confirm the
  // resolved path still lives inside uploadDir before touching the
  // filesystem. path.basename() strips any directory components outright.
  const safeName = path.basename(name);
  const filePath = path.join(uploadDir, safeName);
  const resolvedUploadDir = path.resolve(uploadDir) + path.sep;
  const resolvedFilePath = path.resolve(filePath);

  if (!resolvedFilePath.startsWith(resolvedUploadDir)) {
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

  // Delete embeddings from vector store
  deleteChunksByDocument(name);

  if (fs.existsSync(resolvedFilePath)) {
    fs.unlinkSync(resolvedFilePath);
  }

  console.log(`[documents] Deleted document: ${name}`);
  return NextResponse.json(filtered);
}