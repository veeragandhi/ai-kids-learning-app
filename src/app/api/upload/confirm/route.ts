// app/api/upload/confirm/route.ts — parent approves staged OCR text.
// POST { jobId, childId, editedText? } -> finalizeDocumentText() (chunk + embed).
// Only whitelisted pending jobs can be confirmed; path traversal impossible
// (job ids are basename'd UUIDs, file names come from the stored job).
// The job is bound to its verified child at upload time; a mismatched
// child/job combination is rejected before anything is embedded.

import { NextResponse } from "next/server";
import { deleteOcrJob, getOcrJob } from "@/lib/ocr-jobs";
import { finalizeDocumentText } from "@/lib/ingest";
import { verifyChildOwnership } from "@/lib/supabase/requireChild";
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
    // Verify the caller's child BEFORE loading the job — fail closed.
    const verified = await verifyChildOwnership(req, body.childId);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: verified.status });
    }
    const job = getOcrJob(jobId);
    if (!job) {
      return NextResponse.json(
        { error: "Review not found or expired. Please upload the PDF again." },
        { status: 404 }
      );
    }
    // Job/child binding: jobs written before the binding field existed carry
    // no childId and are demo-only; anything else must match exactly. Same
    // 404 for missing vs foreign — no oracle for guessing job IDs.
    const jobOwner = typeof job.childId === "string" ? job.childId : null;
    if (jobOwner === null) {
      if (verified.mode !== "demo") {
        return NextResponse.json(
          { error: "Review not found or expired. Please upload the PDF again." },
          { status: 404 }
        );
      }
    } else if (jobOwner !== verified.childId) {
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
    await finalizeDocumentText(job.textFileName, finalText, job.source, {
      childId: verified.childId,
    });
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
