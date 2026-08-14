import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { extractPdfText } from "@/lib/pdf";
import { addDocument, saveTextDocument } from "@/lib/documents";
import { addChunks } from "@/lib/vectorStore";
import { chunkText } from "@/lib/chunk";
import { createEmbedding } from "@/lib/embeddings";
import { v4 as uuid } from "uuid";

// P-1: hard cap on upload size to avoid buffering huge files into memory
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// P-1: minimum characters required for an extraction to be considered real
// text (not an empty/garbled result from a scanned or image-only PDF).
const MIN_EXTRACTED_TEXT_LENGTH = 20;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { error: "No file selected" },
        { status: 400 }
      );
    }

    const uploadDir = path.join(process.cwd(), "uploads");

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }

    // P-1: reject oversized files BEFORE reading them into memory
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `File is too large (${(file.size / (1024 * 1024)).toFixed(
            1
          )}MB). Max allowed is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`,
        },
        { status: 413 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    let extractedText = "";

    const extension = path.extname(
      file.name
    ).toLowerCase();

    // TXT support
    if (extension === ".txt") {
      extractedText = buffer.toString("utf-8");
    }
    // PDF support
    else if (extension === ".pdf") {
      extractedText = await extractPdfText(
        buffer
      );
  }
  else {
    return NextResponse.json(
      {
        error: "Only .txt and .pdf supported"
      },
      { status: 400 }
    );
  }

  // P-1: guard against scanned/image-only PDFs (or corrupt/empty text files).
  // pdf2json only reads the text layer, so a scanned page silently returns "".
  // Never report success: true in that case — surface it to the parent instead.
  if (!extractedText || extractedText.trim().length < MIN_EXTRACTED_TEXT_LENGTH) {
    return NextResponse.json(
      {
        error:
          extension === ".pdf"
            ? "We couldn't find readable text in this PDF. It may be a scanned or image-only document — OCR support isn't available yet. Please try a text-based PDF or a .txt file."
            : "This file appears to be empty. Please upload a document that contains text.",
      },
      { status: 422 }
    );
  }

  // save extracted text as .txt internally
 const baseName =
  path.parse(file.name).name;

  const textFileName =
  `${baseName}.txt`;

  saveTextDocument(
    textFileName,
    extractedText
  );

  addDocument(textFileName);

   const textChunks =
      chunkText(extractedText);

    const vectorChunks =
      await Promise.all(
        textChunks.map(
          async (chunkText, index) => ({
            id: uuid(),
            text: chunkText,
            embedding:
              await createEmbedding(
                chunkText
              ),
            documentName: textFileName,
          })
        )
      );

    addChunks(vectorChunks);
  
  return NextResponse.json({
    success: true,
    message: "Document uploaded successfully"
  });

  } catch (error) {
      console.error(error);

      return NextResponse.json(
        { error: "Upload failed" },
        { status: 500 }
      );
  }
}