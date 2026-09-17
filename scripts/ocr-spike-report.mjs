// scripts/ocr-spike-report.mjs
//
// Spike comparison for the AmigosNest OCR decision (see artifacts/ocr-spike).
// Question it answers: is basic OCR (Tesseract) enough for a scanned kids'
// worksheet, or do we need layout-aware OCR (Ollama vision)?
//
// It mirrors the gates in lib/ocr.ts EXACTLY, so the numbers here validate the
// thresholds the upload route actually enforces:
//   isGoodTextLayer        -> >=20 chars, >=50% alnum, >=5 long words
//   detectWorksheetStructure / isGoodTesseractResult -> conf >= 75 + >=2 signals
//   isSkippableImage       -> <50KB embedded JPEGs are watermark strips
//
// Usage (PowerShell, from the repo root):
//   node scripts/ocr-spike-report.mjs                        # both engines, all images
//   node scripts/ocr-spike-report.mjs --engines tesseract     # fast pass only
//   node scripts/ocr-spike-report.mjs --image extracted-2.jpg
//   node scripts/ocr-spike-report.mjs --engines vision --vision-timeout 300000
//
// Outputs: artifacts/ocr-spike/spike-summary.json (machine readable)
//          artifacts/ocr-spike/SPIKE-REPORT.md      (verdict for humans)
// Fresh transcripts are written as <name>.<tag>.<engine>.txt so the original
// spike evidence is never overwritten.

import fs from "fs";
import path from "path";
import { createWorker } from "tesseract.js";

const SPIKE_DIR = path.join(process.cwd(), "artifacts", "ocr-spike");
const PDF_PATH = path.join(SPIKE_DIR, "IraWorksheet.pdf");
const SUMMARY_PATH = path.join(SPIKE_DIR, "spike-summary.json");
const REPORT_PATH = path.join(SPIKE_DIR, "SPIKE-REPORT.md");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ENGINES = opt("--engines", "tesseract,vision")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ONLY_IMAGE = opt("--image", null);
const VISION_MODEL = opt("--vision-model", "gemma3:4b");
const VISION_TIMEOUT_MS = Number(opt("--vision-timeout", "300000"));
const RUN_TAG = opt("--tag", "run2");
const REPORT_ONLY = args.includes("--report-only");

// ---------------------------------------------------------------------------
// Gates mirrored from lib/ocr.ts (keep in sync when thresholds change)
// ---------------------------------------------------------------------------

const BLANK_MARKER = "[BLANK]";

function textQuality(text) {
  const raw = text || "";
  const chars = raw.trim().length;
  const total = raw.replace(/\s/g, "").length;
  const alphaNum = (raw.match(/[A-Za-z0-9]/g) || []).length;
  const words = raw.split(/\s+/).filter(Boolean);
  const longWordCount = words.filter((w) => /[A-Za-z0-9]{3,}/.test(w)).length;
  return {
    chars,
    alphaNumRatio: total === 0 ? 0 : alphaNum / total,
    wordCount: words.length,
    longWordCount,
  };
}

function isGoodTextLayer(text) {
  const q = textQuality(text);
  return q.chars >= 20 && q.alphaNumRatio >= 0.5 && q.longWordCount >= 5;
}

const STRUCTURE_CHECKS = [
  { name: "numbered-questions", re: /(?:^|\n)\s*(?:Q\.?\s?\d+|\d+\s*[.)]\s)/im },
  { name: "question-mark", re: /\?/ },
  { name: "lettered-options", re: /(?:^|\n)\s*[A-E]\s*[.)]/im },
  { name: "slash-options", re: /\([^()\n]{1,60}\/[^()\n]{1,60}\)/ },
  { name: "blanks", re: /_{2,}|…{1,}|\.{3,}|\[BLANK\]|\[blank\]/ },
  { name: "name-field", re: /\bName\s*:/i },
  { name: "date-field", re: /\bDate\s*:/i },
  { name: "page-marker", re: /\bPage\s*\d+/i },
  {
    name: "instruction-verb",
    re: /\b(Tick|Match|Circle|Write|Read|Answer|Choose|Fill|Look at)\b/i,
  },
];

function detectWorksheetStructure(text) {
  const src = text || "";
  const signals = STRUCTURE_CHECKS.filter((c) => c.re.test(src)).map((c) => c.name);
  return { score: signals.length, signals, isWorksheet: signals.length >= 2 };
}

function isGoodTesseractResult(text, confidence) {
  const structure = detectWorksheetStructure(text);
  const q = textQuality(text);
  if (!Number.isFinite(confidence) || confidence < 75) {
    return { ok: false, reason: `tesseract confidence ${confidence} below 75`, structure };
  }
  if (!structure.isWorksheet) {
    return { ok: false, reason: `no worksheet structure (score ${structure.score})`, structure };
  }
  if (q.chars < 20 || q.alphaNumRatio < 0.4 || q.longWordCount < 5) {
    return { ok: false, reason: `ocr text quality too low (chars=${q.chars})`, structure };
  }
  return { ok: true, reason: "tesseract fast-pass accepted", structure };
}
// lib/ocr.ts: 4. PDF -> JPEG extraction (SOI..EOI scan, no native deps)
function extractJpegImages(pdf) {
  const images = [];
  let pos = 0;
  while (pos < pdf.length) {
    const start = pdf.indexOf(Buffer.from([0xff, 0xd8]), pos);
    if (start === -1) break;
    const end = pdf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end === -1) break;
    images.push(pdf.subarray(start, end + 2));
    pos = end + 2;
  }
  return images;
}

function isSkippableImage(buf) {
  return buf.length < 50 * 1024;
}

export function normalizeWorksheetText(text) {
  let out = (text || "").replace(/\r\n?/g, "\n");
  out = out.replace(/\[blank\]/g, BLANK_MARKER);
  out = out.replace(/[□☐✓✔]/g, " [ ] ");
  out = out.replace(/_{2,}/g, ` ${BLANK_MARKER} `);
  out = out.replace(/…+/g, ` ${BLANK_MARKER} `);
  out = out.replace(/(?:\.\s*){3,}/g, ` ${BLANK_MARKER} `);
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// lib/chunk.ts current defaults
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  return chunks;
}

// lib/ocr.ts VISION_PROMPT, copied verbatim so the spike measures the shipped prompt.
const VISION_PROMPT =
  `You are transcribing a kids' worksheet image for a Retrieval-Augmented ` +
  `Generation (RAG) pipeline. Transcribe ALL visible printed text EXACTLY, ` +
  `preserving reading order and question numbers. ` +
  `Write fill-in blanks as ${BLANK_MARKER}. Write checkboxes as [ ]. ` +
  `Describe pictures/diagrams as [Image: brief description]. ` +
  `After the transcription add a section "LAYOUT NOTES:" describing images, ` +
  `columns, tables, matching lines and handwriting zones. ` +
  `Do NOT answer the worksheet questions. Do NOT invent text that is not ` +
  `visible. If a word is illegible, write [illegible].`;

// ---------------------------------------------------------------------------
// Ground truth: read directly off artifacts/ocr-spike/extracted-2.jpg
// (the real scanned page). Used to score both engines from below.
// ---------------------------------------------------------------------------

export const GROUND_TRUTH = {
  // 9 passage sentences a lesson must be able to ground on.
  sentences: [
    "father and mother and children make a family",
    "father and mother together are called parents",
    "a family which has one or two children is called a small family",
    "a family with grandparents parents and children is a large family",
    "in a joint family grandparents parents uncles aunts and cousins live together",
    "the members of a family love one another",
    "all of them share the work parents care for their children",
    "they give their children all they need parents help their children",
    "they also play with their children",
  ],
  // Concepts Ask/lesson/quiz will query for.
  terms: [
    "family",
    "small family",
    "large family",
    "joint family",
    "parents",
    "grandparents",
    "uncles",
    "aunts",
    "cousins",
    "share the work",
    "care for their children",
    "play with their children",
    "neighbours",
    "tick",
    "look at the pictures",
  ],
  questionNumbers: 7, // section A: 1..7
  slashOptionGroups: 7, // each question has one "(x / y)" pair
  sectionHeaders: 2, // "A." and "B."
  // Phrases that exist ONLY in a different worksheet. If an engine emits them,
  // it fabricated content (see the watermark-strip hallucination finding).
  hallucinationProbes: [
    "capital of france",
    "mammal",
    "draw a circle",
    "triangle",
    "rectangle",
    "fish",
  ],
};
// ---------------------------------------------------------------------------
// Scoring: fuzzy-aware, so a single OCR letter slip (Vather/father) is not
// counted as a total miss, but fabricated content always is.
// ---------------------------------------------------------------------------

function tokensOf(text) {
  return (text || "").toLowerCase().match(/[a-z]+/g) || [];
}

// true when a === b or a and b differ by exactly one insert/delete/replace
function withinEditDistance1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function wordPresent(needle, tokenSet) {
  if (tokenSet.has(needle)) return true;
  for (const t of tokenSet) {
    if (Math.abs(t.length - needle.length) <= 1 && withinEditDistance1(needle, t)) {
      return true;
    }
  }
  return false;
}

// Contiguous fuzzy phrase match: "( large / small )" survives, "joints small" does not.
function phrasePresent(phrase, toks) {
  const parts = phrase.split(" ").filter(Boolean);
  for (let i = 0; i + parts.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      if (!withinEditDistance1(parts[k], toks[i + k])) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function sentenceRecall(text, sentences) {
  const set = new Set(tokensOf(text));
  const recalled = [];
  const missed = [];
  for (const s of sentences) {
    const words = [...new Set(tokensOf(s).filter((w) => w.length >= 4))];
    const hits = words.filter((w) => wordPresent(w, set)).length;
    const ratio = words.length === 0 ? 0 : hits / words.length;
    (ratio >= 0.75 ? recalled : missed).push(s);
  }
  return { recalled: recalled.length, total: sentences.length, missed };
}

function termRecall(text, terms) {
  const toks = tokensOf(text);
  const hit = [];
  const missed = [];
  for (const term of terms) {
    (phrasePresent(term, toks) ? hit : missed).push(term);
  }
  return { hits: hit.length, total: terms.length, missed };
}

function noiseProfile(text) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const noiseLines = lines.filter((l) => (l.match(/[A-Za-z]{2,}/g) || []).length < 2);
  const noiseChars = noiseLines.reduce((n, l) => n + l.length, 0);
  const chars = (text || "").length || 1;
  return {
    nonEmptyLines: lines.length,
    noiseLineCount: noiseLines.length,
    noiseChars,
    signalRatio: Number((1 - noiseChars / chars).toFixed(3)),
    noiseSamples: noiseLines.slice(0, 5),
  };
}

function structureProfile(text) {
  const lines = (text || "").split("\n");
  const numbers = new Set();
  for (const line of lines) {
    const m = line.match(/^\s*(\d)\s*[.)]/);
    if (m) numbers.add(Number(m[1]));
  }
  const sectionHeaders = lines.filter((l) => /^\s*[AB]\s*[.)]/.test(l)).length;
  const slashGroups = (text.match(/\([^()\n]{1,60}\/[^()\n]{1,60}\)/g) || []).length;
  const lower = (text || "").toLowerCase();
  const orderMarkers = ["read and understand", "tick", "look at the pictures"].map(
    (m) => lower.indexOf(m)
  );
  return {
    questionNumbersFound: numbers.size,
    questionNumbersPresent: [...numbers].sort((a, b) => a - b),
    slashOptionGroups: slashGroups,
    sectionHeaders,
    imageCaption: /\[image|image of|picture of|illustration|drawing of/i.test(text),
    imageCaptionCount: (text.match(/\[image/gi) || []).length,
    instructionVerbs: ["tick", "look at the pictures"].filter((v) => lower.includes(v)).length,
    readingOrderOk: orderMarkers.every((v, i) => v >= 0 && (i === 0 || v > orderMarkers[i - 1])),
  };
}

function ragProfile(text) {
  const normalized = normalizeWorksheetText(text);
  const chunks = chunkText(normalized);
  const pairRe = /(?:^|[\s])\d\s*[.)][\s\S]{0,200}?\([^()\n]{1,60}\/[^()\n]{1,60}\)/g;
  const intactPairs = chunks.reduce((n, c) => n + ((c.match(pairRe) || []).length), 0);
  return {
    chunks: chunks.length,
    avgChunkChars: Math.round(normalized.length / Math.max(chunks.length, 1)),
    intactQuestionOptionPairs: intactPairs,
    blanksAfterNormalize: (normalized.match(/\[BLANK\]/g) || []).length,
    checkboxesAfterNormalize: (normalized.match(/\[ \]/g) || []).length,
    lowercaseMarkerLeak: /\[blank\]/.test(normalized),
  };
}

function hallucinationProbes(text) {
  const lower = (text || "").toLowerCase();
  return GROUND_TRUTH.hallucinationProbes.filter((p) => lower.includes(p));
}

export function scoreEngine(text) {
  const q = textQuality(text);
  const structure = detectWorksheetStructure(text);
  return {
    chars: q.chars,
    alphaNumRatio: Number(q.alphaNumRatio.toFixed(3)),
    wordCount: q.wordCount,
    longWordCount: q.longWordCount,
    isGoodTextLayer: isGoodTextLayer(text),
    structureScore: structure.score,
    structureSignals: structure.signals,
    sentences: sentenceRecall(text, GROUND_TRUTH.sentences),
    terms: termRecall(text, GROUND_TRUTH.terms),
    structure: structureProfile(text),
    noise: noiseProfile(text),
    rag: ragProfile(text),
    hallucinations: hallucinationProbes(text),
  };
}
// ---------------------------------------------------------------------------
// Engines: Tesseract fast-pass + Ollama vision slow-pass (both local)
// ---------------------------------------------------------------------------

function flattenWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const w of l.words || []) out.push(w);
      }
    }
  }
  return out;
}

async function runTesseract(image) {
  console.log(`[tesseract] recognizing ${image.length} bytes ...`);
  const start = Date.now();
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(image);
    const ms = Date.now() - start;
    const words = flattenWords(data);
    const confs = words
      .map((w) => w.confidence)
      .filter((c) => Number.isFinite(c));
    const lowConf = confs.filter((c) => c < 60).length;
    const text = data.text || "";
    const confidence =
      typeof data.confidence === "number" ? Number(data.confidence.toFixed(2)) : null;
    const gate = isGoodTesseractResult(text, confidence ?? -1);
    return {
      engine: "tesseract",
      ms,
      charsPerSec: Math.round(text.length / Math.max(ms / 1000, 0.001)),
      confidence,
      wordsWithConfidence: confs.length,
      meanWordConfidence: confs.length
        ? Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(2))
        : null,
      lowConfidenceWordShare: confs.length
        ? Number((lowConf / confs.length).toFixed(3))
        : null,
      gate: {
        ok: gate.ok,
        reason: gate.reason,
        structureScore: gate.structure.score,
        signals: gate.structure.signals,
      },
      text,
    };
  } finally {
    await worker.terminate();
  }
}

async function runVision(image) {
  console.log(
    `[vision] ${VISION_MODEL} transcribing ${image.length} bytes (timeout ${VISION_TIMEOUT_MS}ms) ...`
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: VISION_PROMPT,
        images: [image.toString("base64")],
        stream: false,
        options: { temperature: 0, num_predict: 1000, num_ctx: 2048 },
      }),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      throw new Error(`Ollama vision failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const text = data.response || "";
    return {
      engine: "vision",
      model: VISION_MODEL,
      ms,
      charsPerSec: Math.round(text.length / Math.max(ms / 1000, 0.001)),
      exceedsRouteTimeout: ms > 180000, // lib/upload VISION_TIMEOUT_MS = 180000
      text,
    };
  } catch (err) {
    return {
      engine: "vision",
      model: VISION_MODEL,
      ms: Date.now() - start,
      error:
        err && err.name === "AbortError"
          ? `aborted after ${VISION_TIMEOUT_MS}ms`
          : String((err && err.message) || err),
      text: "",
    };
  } finally {
    clearTimeout(timer);
  }
}
// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

const NA = "—";

function pct(n, d) {
  return n === undefined || n === null ? NA : `${n}/${d}`;
}

function comparisonTable(records) {
  const picks = records.filter((r) => r.engines.tesseract || r.engines.vision);
  const header =
    "| Metric | Tesseract (basic OCR) | Ollama vision (layout-aware) |\n" +
    "| --- | --- | --- |";
  const rows = [];
  const add = (label, fn) => {
    const cells = picks.map((r) => {
      const t = r.engines.tesseract;
      const v = r.engines.vision;
      const o = t ? t : v;
      try {
        return fn(t, v, o) ?? NA;
      } catch {
        return NA;
      }
    });
    rows.push(`| ${label} | ${cells.join(" | ")} |`);
  };

  add("File (bytes)", () => `${picks[0].file} (${picks[0].bytes})`);
  add("Status", (t, v) => (t ? (t.error ? `error: ${t.error}` : "ran") : NA) + " | " + (v ? (v.error ? `**${v.error}**` : "ran") : NA));
  add("Runtime", (t, v) => (t ? `${Math.round(t.ms / 1000)}s` : NA) + " | " + (v ? `${Math.round(v.ms / 1000)}s` : NA));
  add("Throughput", (t, v) => (t ? `${t.charsPerSec} chars/s` : NA) + " | " + (v ? `${v.charsPerSec} chars/s` : NA));
  add("Chars extracted", (t, v) => (t ? t.score.chars : NA) + " | " + (v && v.score ? v.score.chars : NA));
  add("Tesseract confidence", (t) => (t && t.confidence !== null ? `${t.confidence} (mean word ${t.meanWordConfidence}, ${Math.round((t.lowConfidenceWordShare || 0) * 100)}% words <60)` : NA));
  add("Text-layer gate", (t, v) => (t ? (t.score.isGoodTextLayer ? "pass" : "**fail**") : NA) + " | " + (v && v.score ? (v.score.isGoodTextLayer ? "pass" : "**fail**") : NA));
  add("Worksheet structure signals", (t, v) => (t ? `${t.score.structureScore}/9` : NA) + " | " + (v && v.score ? `${v.score.structureScore}/9` : NA));
  add("Passage sentences recovered (9)", (t, v) => (t ? pct(t.score.sentences.recalled, 9) : NA) + " | " + (v && v.score ? pct(v.score.sentences.recalled, 9) : NA));
  add("Key concepts recovered (15)", (t, v) => (t ? pct(t.score.terms.hits, 15) : NA) + " | " + (v && v.score ? pct(v.score.terms.hits, 15) : NA));
  add("Question numbers 1–7", (t, v) => (t ? pct(t.score.structure.questionNumbersFound, 7) : NA) + " | " + (v && v.score ? pct(v.score.structure.questionNumbersFound, 7) : NA));
  add('"(x / y)" option pairs (7)', (t, v) => (t ? pct(Math.min(t.score.structure.slashOptionGroups, 7), 7) : NA) + " | " + (v && v.score ? pct(Math.min(v.score.structure.slashOptionGroups, 7), 7) : NA));
  add("Section headers A./B.", (t, v) => (t ? t.score.structure.sectionHeaders : NA) + " | " + (v && v.score ? v.score.structure.sectionHeaders : NA));
  add("Picture described as [Image: …]", (t, v) => (t ? (t.score.structure.imageCaption ? "yes" : "**no**") : NA) + " | " + (v && v.score ? (v.score.structure.imageCaption ? "yes" : "no") : NA));
  add("Drawings described (2 in this worksheet)", (t, v) => (t ? (t.score.structure.imageCaptionCount || 0) : NA) + " | " + (v && v.score ? (v.score.structure.imageCaptionCount || 0) : NA));
  add("Reading order preserved", (t, v) => (t ? (t.score.structure.readingOrderOk ? "yes" : "**no**") : NA) + " | " + (v && v.score ? (v.score.structure.readingOrderOk ? "yes" : "**no**") : NA));
  add("Noise lines / signal ratio", (t, v) => (t ? `${t.score.noise.noiseLineCount} / ${t.score.noise.signalRatio}` : NA) + " | " + (v && v.score ? `${v.score.noise.noiseLineCount} / ${v.score.noise.signalRatio}` : NA));
  add(`RAG chunks (${CHUNK_SIZE}/${CHUNK_OVERLAP})`, (t, v) => (t ? t.score.rag.chunks : NA) + " | " + (v && v.score ? v.score.rag.chunks : NA));
  add("Question + options kept in one chunk (7)", (t, v) => (t ? pct(Math.min(t.score.rag.intactQuestionOptionPairs, 7), 7) : NA) + " | " + (v && v.score ? pct(Math.min(v.score.rag.intactQuestionOptionPairs, 7), 7) : NA));
  add("Fabricated content", (t, v) => (t ? (t.score.hallucinations.length ? `**${t.score.hallucinations.join(", ")}**` : "none") : NA) + " | " + (v && v.score ? (v.score.hallucinations.length ? `**${v.score.hallucinations.join(", ")}**` : "none") : NA));

  return header + "\n" + rows.join("\n");
}

function writeReport(summary) {
  const pages = summary.images.filter((r) => r.engines.tesseract || r.engines.vision);
  const main = pages[0];
  const t = main ? main.engines.tesseract : null;
  const v = main ? main.engines.vision : null;
  const findings = [];

  if (main) {
    findings.push(
      t && t.gate && t.gate.ok
        ? `**Tesseract passes the lib/ocr.ts fast-pass on this page** (conf ${t.confidence}, ${t.score.structureScore}/9 structure signals) → the page is embedded without paying the vision path.`
        : `**Tesseract is rejected by the lib/ocr.ts fast-pass on this page** (${t ? t.gate.reason : "no tesseract run"}) → every scan like this one falls through to the vision slow-pass, so the vision timeout is on the critical path.`
    );
    if (t) {
      findings.push(
        `**Pictures are lost by basic OCR.** Tesseract produced ${t.score.noise.noiseLineCount} noise lines ` +
          `(signal ratio ${t.score.noise.signalRatio}) where section B's two drawings are printed, and it never ` +
          `describes them; vision emitted an \`[Image: …]\` caption, which is the only way a lesson or quiz can ` +
          `reference the picture task at all.`
      );
      findings.push(
        `**Question structure survives but is dirty.** Tesseract recovered ${t.score.structure.questionNumbersFound}/7 ` +
          `number markers and ${Math.min(t.score.structure.slashOptionGroups, 7)}/7 \`(x / y)\` option pairs ` +
          `(e.g. \`(joints small )\`, \`( share J care )\`). lib/retrieval.ts scores lexical overlap against the ` +
          `child's wording, so mangled option words reduce recall for exactly the questions a worksheet asks.`
      );
    }
    if (v && v.score) {
      const secs = Math.round(v.ms / 1000);
      const budget = Math.round((summary.routeVisionTimeoutMs || 180000) / 1000);
      const usedPct = Math.round((v.ms / (summary.routeVisionTimeoutMs || 180000)) * 100);
      const timingVerdict = v.exceedsRouteTimeout
        ? `**over the ${budget}s VISION_TIMEOUT_MS** in app/api/upload/route.ts`
        : usedPct >= 80
          ? `**only ${100 - usedPct}% inside the ${budget}s VISION_TIMEOUT_MS** in app/api/upload/route.ts, i.e. a marginal pass rather than a safe one`
          : `comfortably inside the ${budget}s route budget`;
      findings.push(
        `**Vision is accurate but slow.** ${secs}s for one page — ${timingVerdict}. An earlier run on this machine ` +
          `measured 219s for the same page, and dev-ocr2.log records a real upload aborting at 180s, so this budget ` +
          `does not reliably cover a single worksheet on CPU.`
      );
      findings.push(
        `**Vision fabricates content on non-page images.** Given only the 12KB \`Scanned with OKEN Scanner\` ` +
          `watermark strip embedded in this same PDF, the earlier vision run returned a complete five-question ` +
          `worksheet ("What is the capital of France?", checkboxes, "Draw a circle") that does not exist in that ` +
          `image. \`isSkippableImage()\` (\`<50KB\`) is the guard that stops that fabrication from being embedded.`
      );
    }
    const drawings = v && v.score ? v.score.structure.imageCaptionCount || 0 : 0;
    if (v && v.score && drawings < 2) {
      findings.push(
        `**Vision's picture coverage is partial.** Section B contains two drawings; vision described ` +
          `${drawings} of them, so a lesson built from this text can only talk about one picture task. ` +
          `Picture descriptions are best-effort hints, not verified content.`
      );
    }
    if (v && v.error) {
      findings.push(
        `**The vision fallback can fail outright.** Run result: \`${v.error}\`. dev-ocr2.log shows the same shape ` +
          `in the running app: \`[upload][ocr] vision failed page 1: AbortError\` → \`POST /api/upload 422 in 3.3min\`. ` +
          `A parent uploading this worksheet today gets an error, not a lesson.`
      );
    }
  }

  const strip = (summary.priorRuns || []).find((r) => r.bytes < 50 * 1024);
  if (strip && strip.vision && strip.vision.hallucinations.length) {
    findings.push(
      `**Watermark-strip evidence (prior run, kept for provenance):** \`${strip.file}\` (${strip.bytes} bytes) ` +
        `produced ${strip.vision.hallucinations.length} fabricated phrases ` +
        `(${strip.vision.hallucinations.join(", ")}) while Tesseract returned only ` +
        `${strip.tesseract ? strip.tesseract.chars : "?"} chars ("Scanned with OKEN Scanner").`
    );
  }

  const lines = reportLines(summary, pages, findings);
  fs.writeFileSync(REPORT_PATH, lines.join("\n"), "utf-8");
}

function reportLines(summary, pages, findings) {
  const gateRows = pages.map((r) => {
    const tt = r.engines.tesseract;
    const vv = r.engines.vision;
    const verdict =
      tt && tt.gate && tt.gate.ok
        ? "Accept fast-pass → embed"
        : vv && vv.score && vv.score.isGoodTextLayer
          ? "Fast-pass rejected → vision text staged for parent review"
          : 'Both rejected → 422 "try a clearer scan"';
    const tessCell = tt
      ? `conf ${tt.confidence}${tt.gate && tt.gate.ok ? " ✅" : ""}`
      : NA;
    return `| \`${r.file}\` | ${tessCell} | ${tt ? `${tt.score.structureScore}/9` : NA} | ${verdict} |`;
  });

  const v = pages[0] ? pages[0].engines.vision : null;

  return [
    "# OCR Spike — basic OCR vs layout-aware OCR",
    "",
    `Generated: ${summary.generatedAt}  `,
    `Machine: ${summary.host}, node ${summary.node}  `,
    `Corpus: \`artifacts/ocr-spike/${summary.pdf.file}\` (${summary.pdf.bytes} bytes)  `,
    `Engines: Tesseract (tesseract.js, local) vs Ollama \`${summary.visionModel}\` (local vision)  `,
    `Gates under test: \`lib/ocr.ts\` — isGoodTextLayer, detectWorksheetStructure, isGoodTesseractResult, isSkippableImage  `,
    `Chunking under test: \`lib/chunk.ts\` ${summary.chunking.size}/${summary.chunking.overlap}`,
    "",
    "## 1. What the PDF actually contains",
    "",
    "`pdf2json` returns **0 pages with text** for this file (image-only scan), so the upload route " +
      "reaches its OCR branch. Scanning the raw bytes for JPEG markers — the same logic as " +
      `\`extractJpegImages\` — finds ${summary.pdf.embeddedImages.length} embedded image(s):`,
    "",
    "| # | Bytes | On-disk render | Gate decision |",
    "| --- | --- | --- | --- |",
    ...summary.pdf.embeddedImages.map(
      (i) =>
        `| ${i.index} | ${i.bytes} | \`${i.matchesOnDisk || NA}\` | ` +
        `${i.skippable ? "**skipped** (watermark strip, <50KB)" : "treated as a page"} |`
    ),
    "",
    "## 2. Measured comparison (main page scan)",
    "",
    comparisonTable(pages),
    "",
    "## 3. Gate verdicts (what the shipped code does with each engine)",
    "",
    "| Page | Tesseract | Structure | Verdict |",
    "| --- | --- | --- | --- |",
    ...gateRows,
    "",
    "## 4. Findings",
    "",
    ...findings.map((f, i) => `${i + 1}. ${f}`),
    "",
    "## 5. Recommendation",
    "",
    "- Keep the **hybrid** shape: Tesseract fast-pass first (seconds, local, no model download), Ollama vision as the per-page fallback.",
    "- Keep the **parent review gate** — OCR is imperfect on handwriting and picture sections, and the RAG rules in AGENTS.md forbid grounding answers in unverified text.",
    "- Keep `isSkippableImage()` and the `confidence >= 75` + structure gate; both are validated by this spike.",
    v &&
    (v.exceedsRouteTimeout ||
      v.ms > 0.8 * (summary.routeVisionTimeoutMs || 180000))
      ? "- **Raise `VISION_TIMEOUT_MS`** in `app/api/upload/route.ts` (and surface an \"OCR is slow, this can take a few minutes\" state in the upload UI), because measured vision time consumes most or all of the 180s budget on CPU."
      : "- Vision timing stayed well inside the route budget on this machine; re-check on slower hardware before lowering the timeout.",
    "- Picture sections survive only via vision. If a worksheet is mostly pictures, the vision path is required — do not optimise it away.",
    "",
    "## 6. Reproduce",
    "",
    "```powershell",
    "# Tesseract only (fast)",
    "node scripts/ocr-spike-report.mjs --engines tesseract",
    "",
    "# Both engines (Ollama must be running; CPU-bound, allow several minutes)",
    "node scripts/ocr-spike-report.mjs --engines tesseract,vision --vision-timeout 300000",
    "```",
    "",
    "Raw transcripts are written next to this report as `<image>.<tag>.<engine>.txt`; " +
      "machine-readable metrics are in `spike-summary.json`. Earlier spike runs " +
      "(`<image>.tesseract.txt` / `<image>.vision.txt`) are left untouched for provenance.",
    "",
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function onDiskImages() {
  return fs
    .readdirSync(SPIKE_DIR)
    .filter((f) => /^extracted-\d+\.jpg$/i.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

function priorTranscript(name, engine) {
  const p = path.join(SPIKE_DIR, `${name}.${engine}.txt`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
}

async function main() {
  // --report-only: rebuild SPIKE-REPORT.md from an existing spike-summary.json
  // (no Tesseract, no Ollama) so the write-up can be iterated in seconds.
  if (REPORT_ONLY) {
    if (!fs.existsSync(SUMMARY_PATH)) {
      console.error(`Missing ${SUMMARY_PATH} — run the spike once first.`);
      process.exit(1);
    }
    const saved = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8"));

    // Re-score from the transcripts on disk so layering new metrics onto the
    // report never requires paying for another vision run.
    const transcriptPath = (file, tag, engine) => {
      const candidates = [
        `${path.parse(file).name}.${tag}.${engine}.txt`,
        `${file}.${tag}.${engine}.txt`,
      ];
      for (const c of candidates) {
        const p = path.join(SPIKE_DIR, c);
        if (fs.existsSync(p)) return p;
      }
      return null;
    };
    for (const rec of saved.images || []) {
      for (const engine of ["tesseract", "vision"]) {
        const entry = rec.engines && rec.engines[engine];
        if (!entry) continue;
        const p = transcriptPath(rec.file, saved.tag || RUN_TAG, engine);
        if (p) entry.score = scoreEngine(fs.readFileSync(p, "utf-8"));
      }
    }
    for (const pr of saved.priorRuns || []) {
      const t = priorTranscript(pr.file, "tesseract");
      const v = priorTranscript(pr.file, "vision");
      pr.tesseract = t ? scoreEngine(t) : null;
      pr.vision = v ? scoreEngine(v) : null;
    }

    writeReport(saved);
    console.log(
      `Regenerated ${path.relative(process.cwd(), REPORT_PATH)} from spike-summary.json`
    );
    return;
  }

  if (!fs.existsSync(PDF_PATH)) {
    console.error(`Missing ${PDF_PATH}`);
    process.exit(1);
  }
  const pdf = fs.readFileSync(PDF_PATH);
  const embedded = extractJpegImages(pdf);
  const disk = onDiskImages();

  const summary = {
    generatedAt: new Date().toISOString(),
    tag: RUN_TAG,
    node: process.version,
    host: `${process.platform} ${process.arch}`,
    chunking: { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP },
    visionModel: VISION_MODEL,
    visionTimeoutUsedMs: VISION_TIMEOUT_MS,
    routeVisionTimeoutMs: 180000,
    pdf: {
      file: path.basename(PDF_PATH),
      bytes: pdf.length,
      embeddedImages: embedded.map((buf, i) => ({
        index: i + 1,
        bytes: buf.length,
        skippable: isSkippableImage(buf),
        // On-disk renders may differ by a byte or two from the raw stream
        // (EOI handling), so match the closest size instead of requiring equality.
        matchesOnDisk: (() => {
          let best = null;
          let bestDelta = 8; // bytes of tolerance
          for (const f of disk) {
            const delta = Math.abs(fs.statSync(path.join(SPIKE_DIR, f)).size - buf.length);
            if (delta <= bestDelta) {
              best = f;
              bestDelta = delta;
            }
          }
          return best;
        })(),
      })),
    },
    images: [],
  };

  console.log(
    `[pdf] ${path.basename(PDF_PATH)} ${pdf.length} bytes, ${embedded.length} embedded JPEGs`
  );
  for (const info of summary.pdf.embeddedImages) {
    console.log(
      `  image ${info.index}: ${info.bytes} bytes -> ${info.matchesOnDisk || "no on-disk match"} ` +
        `(${info.skippable ? "SKIPPED by isSkippableImage (<50KB)" : "used as a page"})`
    );
  }

  for (const info of summary.pdf.embeddedImages) {
    const name = info.matchesOnDisk || `embedded-${info.index}`;
    if (ONLY_IMAGE && name !== ONLY_IMAGE) continue;
    if (info.skippable && !ONLY_IMAGE) {
      console.log(`  [skip] ${name} is a watermark strip — not a page\n`);
      continue;
    }
    const imageBuffer = embedded[info.index - 1];
    const record = {
      file: name,
      bytes: imageBuffer.length,
      skippable: info.skippable,
      engines: {},
    };

    if (ENGINES.includes("tesseract")) {
      const tess = await runTesseract(imageBuffer);
      fs.writeFileSync(
        path.join(SPIKE_DIR, `${path.parse(name).name}.${RUN_TAG}.tesseract.txt`),
        tess.text,
        "utf-8"
      );
      record.engines.tesseract = { ...tess, text: undefined, score: scoreEngine(tess.text) };
      console.log(
        `[tesseract] ${name}: conf=${tess.confidence} gate=${tess.gate.ok ? "ACCEPT" : "REJECT"} ` +
          `(${tess.gate.reason}) ${tess.ms}ms`
      );
    }

    if (ENGINES.includes("vision") && (!info.skippable || ONLY_IMAGE)) {
      const vis = await runVision(imageBuffer);
      if (vis.text) {
        fs.writeFileSync(
          path.join(SPIKE_DIR, `${path.parse(name).name}.${RUN_TAG}.vision.txt`),
          vis.text,
          "utf-8"
        );
        record.engines.vision = { ...vis, text: undefined, score: scoreEngine(vis.text) };
      } else {
        record.engines.vision = { ...vis, text: undefined };
      }
      console.log(
        `[vision] ${name}: ${vis.error ? `ERROR ${vis.error}` : `${vis.text.length} chars`} ${vis.ms}ms` +
          `${vis.exceedsRouteTimeout ? " (SLOWER than the 180s route timeout)" : ""}`
      );
    }

    summary.images.push(record);
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf-8");
    console.log("");
  }

  // Prior-run transcripts (kept for provenance, incl. the watermark-strip case).
  summary.priorRuns = disk.map((name) => {
    const t = priorTranscript(name, "tesseract");
    const v = priorTranscript(name, "vision");
    return {
      file: name,
      bytes: fs.statSync(path.join(SPIKE_DIR, name)).size,
      tesseract: t ? scoreEngine(t) : null,
      vision: v ? scoreEngine(v) : null,
    };
  });

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf-8");
  writeReport(summary);
  console.log(`Wrote ${path.relative(process.cwd(), SUMMARY_PATH)}`);
  console.log(`Wrote ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// Only run when executed directly, so the scoring helpers can be imported
// (e.g. from a scratch check) without kicking off OCR.
const isEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isEntry) {
  main().catch((err) => {
    console.error("spike failed:", err);
    process.exit(1);
  });
}