import fs from "fs";
import path from "path";
import { createWorker } from "tesseract.js";

const SPIKE_DIR = path.join(process.cwd(), "artifacts", "ocr-spike");
const target = process.argv[2] || "extracted-2.jpg";
const full = path.join(SPIKE_DIR, target);
const base = path.parse(target).name;

// ---- A. Tesseract (rerun for main image) ----
console.log(`[Tesseract] ${target} ...`);
const t0 = Date.now();
const worker = await createWorker("eng");
const { data } = await worker.recognize(full);
await worker.terminate();
console.log(`[Tesseract] done in ${Date.now() - t0}ms, chars=${data.text.length}, conf=${data.confidence?.toFixed?.(1)}`);
fs.writeFileSync(path.join(SPIKE_DIR, `${base}.tesseract.txt`), data.text, "utf-8");

// ---- B. Vision (short, no-think, with timeout + retry) ----
async function visionOnce(timeoutMs) {
  const b64 = fs.readFileSync(full).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: "gemma3:4b",
        prompt: "Transcribe ALL visible text in this kids worksheet image exactly, in reading order. Keep question numbers. Write blanks as [blank]. Do NOT answer the questions. After transcription add LAYOUT NOTES: describing images, columns, tables, handwriting.",
        images: [b64],
        stream: false,
        options: { temperature: 0, num_predict: 800, num_ctx: 2048 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).response || "";
  } finally { clearTimeout(t); }
}
console.log(`[Vision] ${target} via gemma3:4b (timeout 240s, 2 tries) ...`);
let vtext = "";
for (let attempt = 1; attempt <= 2 && !vtext; attempt++) {
  const s = Date.now();
  try { vtext = await visionOnce(240000); console.log(`[Vision] attempt ${attempt} done in ${Date.now() - s}ms, chars=${vtext.length}`); }
  catch (e) { console.log(`[Vision] attempt ${attempt} failed after ${Date.now() - s}ms: ${e.message}`); }
}
if (vtext) fs.writeFileSync(path.join(SPIKE_DIR, `${base}.vision.txt`), vtext, "utf-8");

// ---- structure report ----
function report(t) {
  return {
    chars: t.length,
    nonEmptyLines: t.split("\n").filter((l) => l.trim().length > 0).length,
    questionMarkers: (t.match(/(?:^|\s)(?:Q\.?\s?\d+|\d+\s*[.)])/gm) || []).length,
    blanks: (t.match(/(\[blank\]|_{2,}|\[ \])/g) || []).length,
  };
}
const out = { tesseract: report(data.text), vision: vtext ? report(vtext) : { error: "no response (model timed out on CPU)" } };
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(SPIKE_DIR, `${base}.compare.json`), JSON.stringify(out, null, 2));
