import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { extractPdfText } from "@/lib/pdf";
import {
  BLANK_MARKER,
  extractJpegImages,
  isGoodTesseractResult,
  isGoodTextLayer,
  isSkippableImage,
  normalizeWorksheetText,
  ocrImageBuffer,
  visionTranscribeImage,
} from "@/lib/ocr";
import { createOcrJob, type OcrSource } from "@/lib/ocr-jobs";
import { finalizeDocumentText } from "@/lib/ingest";
import { ollamaVisionModel } from "@/lib/ai";

// P-1: hard cap on upload size to avoid buffering huge files into memory
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// Vision slow-pass budget: gemma3:4b took ~219s/page on CPU in the spike.
// Model is env-configurable (OLLAMA_VISION_MODEL) for beefier machines.
const VISION_TIMEOUT_MS = 180000;
const VISION_MODEL = ollamaVisionModel();

type OcrOutcome =
  | { kind: "text"; text: string; source: OcrSource; detail: string }
  | {
      kind: "review";
      jobId: string;
      preview: string;
      ocrSource: OcrSource;
      detail: string;
    };

// Scanned PDF -> JPEG pages -> Tesseract fast-pass (confidence + structure)
// -> vision slow-pass. Returns review jobs; never auto-embeds OCR text.
async function runOcrPipeline(
  pdf: Buffer,
  textFileName: string
): Promise<OcrOutcome> {
  const images = extractJpegImages(pdf).filter(
    (img) => !isSkippableImage(img)
  );
  if (images.length === 0) {
    return { kind: "text", text: "", source: "ocr-tesseract", detail: "" };
  }
  const pageTexts: string[] = [];
  let tesseractPages = 0;
  for (let i = 0; i < images.length; i++) {
    const { text, confidence } = await ocrImageBuffer(images[i]);
    const check = isGoodTesseractResult(text, confidence);
    console.log(
      `[upload][ocr] page ${i + 1}/${images.length} ` +
        `tesseract conf=${confidence} structure=${check.structure.score} ` +
        `${check.ok ? "accepted" : check.reason}`
    );
    if (check.ok) {
      tesseractPages++;
      pageTexts.push(normalizeWorksheetText(text));
    } else {
      // Vision fallback for this page only; skip page on failure/timeout.
      try {
        const vision = normalizeWorksheetText(
          await visionTranscribeImage(
            images[i],
            VISION_MODEL,
            VISION_TIMEOUT_MS
          )
        );
        if (isGoodTextLayer(vision)) pageTexts.push(vision);
      } catch (err) {
        console.error(`[upload][ocr] vision failed page ${i + 1}:`, err);
      }
    }
  }
  const combined = pageTexts.join("\n\n").trim();
  if (!isGoodTextLayer(combined)) {
    return { kind: "text", text: "", source: "ocr-tesseract", detail: "" };
  }
  const source: OcrSource =
    tesseractPages === images.length ? "ocr-tesseract" : "ocr-vision";
  const job = createOcrJob({
    fileName: textFileName,
    textFileName,
    text: combined,
    source,
    detail:
      source === "ocr-tesseract"
        ? "Scanned PDF read with on-device text recognition. Please review before approving."
        : `Scanned PDF read with on-device vision (${VISION_MODEL}). Slower but preserves layout — please review before approving.`,
  });
  return {
    kind: "review",
    jobId: job.id,
    preview: combined.slice(0, 2000),
    ocrSource: source,
    detail: job.detail,
  };
}

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
    const extension = path.extname(file.name).toLowerCase();
    const baseName = path.parse(file.name).name;
    const textFileName = `${baseName}.txt`;

    // TXT support — direct ingest, no OCR involved.
    if (extension === ".txt") {
      const extractedText = buffer.toString("utf-8");
      if (!isGoodTextLayer(extractedText)) {
        return NextResponse.json(
          {
            error:
              "This file appears to be empty. Please upload a document that contains text.",
          },
          { status: 422 }
        );
      }
      await finalizeDocumentText(textFileName, extractedText, "text");
      return NextResponse.json({
        success: true,
        message: "Document uploaded successfully",
      });
    }

    // PDF support: good text layer -> direct ingest, else OCR review.
    if (extension === ".pdf") {
      const layerText = await extractPdfText(buffer);
      if (isGoodTextLayer(layerText)) {
        await finalizeDocumentText(textFileName, layerText, "text");
        return NextResponse.json({
          success: true,
          message: "Document uploaded successfully",
        });
      }
      console.log(
        `[upload] no usable text layer in ${file.name}, trying OCR pipeline`
      );
      const outcome = await runOcrPipeline(buffer, textFileName);
      if (outcome.kind === "review") {
        return NextResponse.json(
          {
            success: false,
            needsReview: true,
            jobId: outcome.jobId,
            ocrSource: outcome.ocrSource,
            preview: outcome.preview,
            message:
              "This looks like a scanned worksheet. We extracted the text below — " +
              `please check ${BLANK_MARKER} marks the blanks, then approve to add it. ` +
              outcome.detail,
          },
          { status: 202 }
        );
      }
      return NextResponse.json(
        {
          error:
            "We couldn't find readable text in this PDF, even with on-device text recognition. " +
            "Please try a clearer scan or a text-based PDF / .txt file.",
        },
        { status: 422 }
      );
    }

    return NextResponse.json(
      { error: "Only .txt and .pdf supported" },
      { status: 400 }
    );

  } catch (error) {
      console.error(error);

      return NextResponse.json(
        { error: "Upload failed" },
        { status: 500 }
      );
  }
}