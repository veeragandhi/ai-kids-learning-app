// lib/ocr-jobs.ts — pending-review OCR staging + confirm step.
// Upload with needsReview:true writes here and does NOT embed.
// Parent previews text at /upload, then POST /api/upload/confirm
// embeds it. Stale jobs expire after 24h via mtime sweep.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export type OcrSource = "text" | "ocr-tesseract" | "ocr-vision";

export type OcrJob = {
  id: string;
  fileName: string;
  textFileName: string;
  text: string;
  source: OcrSource;
  detail: string;
  createdAt: number;
};

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_TEXT_BYTES = 2 * 1024 * 1024; // 2MB cap on staged text

function pendingDir(): string {
  const dir = path.join(process.cwd(), "uploads", ".pending-ocr");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jobPath(id: string): string {
  return path.join(pendingDir(), `${path.basename(id)}.json`);
}

export function createOcrJob(input: Omit<OcrJob, "id" | "createdAt">): OcrJob {
  if (Buffer.byteLength(input.text || "", "utf-8") > MAX_PENDING_TEXT_BYTES) {
    throw new Error("OCR text too large to stage for review");
  }
  const job: OcrJob = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job), "utf-8");
  sweepExpiredJobs();
  return job;
}

export function getOcrJob(id: string): OcrJob | null {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    const job = JSON.parse(fs.readFileSync(p, "utf-8")) as OcrJob;
    if (Date.now() - job.createdAt > PENDING_TTL_MS) {
      fs.unlinkSync(p);
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

export function deleteOcrJob(id: string): void {
  const p = jobPath(id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function sweepExpiredJobs(): void {
  try {
    for (const f of fs.readdirSync(pendingDir())) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(pendingDir(), f);
      try {
        const job = JSON.parse(fs.readFileSync(p, "utf-8")) as OcrJob;
        if (Date.now() - job.createdAt > PENDING_TTL_MS) fs.unlinkSync(p);
      } catch {
        fs.unlinkSync(p);
      }
    }
  } catch {
    // pending dir missing — nothing to sweep
  }
}
