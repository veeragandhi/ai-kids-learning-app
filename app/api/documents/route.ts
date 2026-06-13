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

  const documents = readDocuments();

  const filtered = documents.filter(
    (doc) => doc.name !== name
  );

  saveDocuments(filtered);

  // Delete embeddings from vector store
  deleteChunksByDocument(name);

  const filePath = path.join(uploadDir, name);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  console.log(`[documents] Deleted document: ${name}`);
  return NextResponse.json(filtered);
}