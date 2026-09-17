// app/api/upload/confirm/route.ts — parent approves staged OCR text.
// POST { jobId, editedText? } -> finalizeDocumentText() (chunk + embed).
// Only whitelisted pending jobs can be confirmed; path traversal impossible
// (job ids are basename'd UUIDs, file names come from the stored job).

import { NextResponse } from "next/server";
import { deleteOcrJob, getOcrJob } from "@/lib/ocr-jobs";
import { finalizeDocumentText } from "@/lib/ingest";
import { isGoodTextLayer } from "@/lib/ocr";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    const editedText =
      typeof body.editedText === "string" ? body.editedText : undefined;
    if (!jobId) {
      return NextResponse.json(
        { error: "A review id is required" },
        { status: 400 }
      );
    }
    const job = getOcrJob(jobId);
    if (!job) {
      return NextResponse.json(
        { error: "Review not found or expired. Please upload the PDF again." },
        { status: 404 }
      );
    }
    const finalText = (editedText ?? job.text).trim();
    if (!isGoodTextLayer(finalText)) {
      return NextResponse.json(
        { error: "The reviewed text is empty. Please keep some text or re-upload." },
        { status: 422 }
      );
    }
    await finalizeDocumentText(job.textFileName, finalText, job.source);
    deleteOcrJob(jobId);
    return NextResponse.json({
      success: true,
      message: `Approved — ${job.textFileName} added to the learning library.`,
    });
  } catch (error) {
    console.error("[upload/confirm]", error);
    return NextResponse.json({ error: "Approval failed" }, { status: 500 });
  }
}
