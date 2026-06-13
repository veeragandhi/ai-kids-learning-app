import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { extractPdfText } from "@/lib/pdf";
import { addDocument, saveTextDocument } from "@/lib/documents";
import { addChunks } from "@/lib/vectorStore";
import { chunkText } from "@/lib/chunk";
import { createEmbedding } from "@/lib/embeddings";
import { v4 as uuid } from "uuid";

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