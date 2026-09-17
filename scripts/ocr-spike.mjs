import fs from "fs";
import path from "path";
import { createWorker } from "tesseract.js";

const SPIKE_DIR = path.join(process.cwd(), "artifacts", "ocr-spike");

async function runTesseract(imagePath, label) {
  console.log(`\n[Tesseract] ${label}: ${path.basename(imagePath)} ...`);
  const start = Date.now();
  const worker = await createWorker("eng");
  const { data } = await worker.recognize(imagePath);
  await worker.terminate();
  const elapsed = Date.now() - start;
  console.log(`[Tesseract] done in ${elapsed}ms, chars=${data.text.length}, conf~${data.confidence?.toFixed?.(1) ?? "?"}`);
  return { text: data.text, confidence: data.confidence, elapsedMs: elapsed };
}

async function runVision(imagePath, label) {
  console.log(`\n[Vision] ${label} via Ollama gemma3:4b ...`);
  const start = Date.now();
  const b64 = fs.readFileSync(imagePath).toString("base64");
  const prompt = `You are transcribing a kids' worksheet image for a Retrieval-Augmented Generation (RAG) pipeline. Transcribe ALL visible printed text EXACTLY, preserving reading order, question numbers, blanks as [blank], checkboxes as [ ], tables row by row. After the transcription, add a section "LAYOUT NOTES:" describing images/diagrams, columns, matching lines, handwriting zones. Do NOT answer the worksheet questions. Do NOT invent text that is not visible. If a word is illegible, write [illegible].`;
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemma3:4b", prompt, images: [b64], stream: false, options: { temperature: 0 } }),
  });
  if (!res.ok) throw new Error(`Ollama vision failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const elapsed = Date.now() - start;
  console.log(`[Vision] done in ${elapsed}ms, chars=${(data.response || "").length}`);
  return { text: data.response || "", elapsedMs: elapsed };
}

function structureReport(text) {
  const lines = text.split("\n");
  return {
    totalChars: text.length,
    nonEmptyLines: lines.filter((l) => l.trim().length > 0).length,
    questionMarkers: (text.match(/(?:^|\s)(?:Q\.?\s?\d+|\d+\s*[.)]\s)/gm) || []).length,
    blanks: (text.match(/(\[blank\]|_{2,}|…+|\[ \])/g) || []).length,
    illegible: (text.match(/\[illegible\]/g) || []).length,
  };
}

const images = fs.readdirSync(SPIKE_DIR).filter((f) => f.startsWith("extracted-") && f.endsWith(".jpg")).sort();
console.log("Images:", images);
const summary = {};
for (const img of images) {
  const full = path.join(SPIKE_DIR, img);
  const base = path.parse(img).name;
  try {
    const tess = await runTesseract(full, base);
    fs.writeFileSync(path.join(SPIKE_DIR, `${base}.tesseract.txt`), tess.text, "utf-8");
    summary[base] = { tesseract: { ...structureReport(tess.text), confidence: tess.confidence, elapsedMs: tess.elapsedMs } };
  } catch (e) { console.error("[Tesseract] FAILED:", e.message); summary[base] = { tesseract: { error: e.message } }; }
  try {
    const vis = await runVision(full, base);
    fs.writeFileSync(path.join(SPIKE_DIR, `${base}.vision.txt`), vis.text, "utf-8");
    summary[base] = { ...summary[base], vision: { ...structureReport(vis.text), elapsedMs: vis.elapsedMs } };
  } catch (e) { console.error("[Vision] FAILED:", e.message); summary[base] = { ...summary[base], vision: { error: e.message } }; }
}
fs.writeFileSync(path.join(SPIKE_DIR, "spike-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
