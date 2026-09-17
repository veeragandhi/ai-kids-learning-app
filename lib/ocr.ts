// lib/ocr.ts — hybrid OCR pipeline for scanned / image-only worksheets.
//
// Pipeline: extractPdfText() -> isGoodTextLayer()? -> Tesseract fast-pass
// (confidence + structure) -> Ollama vision slow-pass -> parent preview gate.
// All local-first: no cloud keys, no kids data leaves the device.
//
// Spike evidence (artifacts/ocr-spike, IraWorksheet.pdf):
// - pdf2json: 0 pages with text (image-only, 2 embedded JPEGs)
// - Tesseract ~15s, 1544 chars, Q-numbers garbled, picture section = garbage
// - gemma3:4b vision ~219s CPU, 2228 chars, 7/7 questions clean + layout notes

import { createWorker } from "tesseract.js";
import path from "path";

export const BLANK_MARKER = "[BLANK]";

// Guard sentence injected into every prompt that consumes worksheet context
// (lesson / quiz / ask / video). Prevents the LLM quoting the marker literally.
export const OCR_MARKER_GUARD =
  `The marker ${BLANK_MARKER} denotes an empty fill-in blank from the worksheet. ` +
  `Never repeat it literally; refer to it as "a missing word" or "the blank".`;

// ---------------------------------------------------------------------------
// 1. Text-layer quality: length alone is not enough (garbage layers exist).
// ---------------------------------------------------------------------------

export type TextQuality = {
  chars: number;
  alphaNumRatio: number;
  wordCount: number;
  longWordCount: number;
};

export function textQuality(text: string): TextQuality {
  const raw = text || "";
  const chars = raw.trim().length;
  const total = raw.replace(/\s/g, "").length;
  const alphaNum = (raw.match(/[A-Za-z0-9]/g) || []).length;
  const words = raw.split(/\s+/).filter(Boolean);
  const longWordCount = words.filter((w) =>
    /[A-Za-z0-9]{3,}/.test(w)
  ).length;
  return {
    chars,
    alphaNumRatio: total === 0 ? 0 : alphaNum / total,
    wordCount: words.length,
    longWordCount,
  };
}

// A real text layer: >=20 chars AND >=50% letters/digits AND >=5 real words.
// Rejects empty scans, binary junk, and 20+ chars of punctuation metadata.
export function isGoodTextLayer(text: string): boolean {
  const q = textQuality(text);
  return (
    q.chars >= 20 && q.alphaNumRatio >= 0.5 && q.longWordCount >= 5
  );
}

// ---------------------------------------------------------------------------
// 2. Worksheet structure detection (Tesseract's second signal).
// "Enough evidence" = at least 2 of the signals below fire.
// ---------------------------------------------------------------------------

export type WorksheetStructure = {
  score: number;
  signals: string[];
  isWorksheet: boolean;
};

const STRUCTURE_CHECKS: Array<{ name: string; re: RegExp }> = [
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

export function detectWorksheetStructure(
  text: string
): WorksheetStructure {
  const src = text || "";
  const signals = STRUCTURE_CHECKS.filter((c) => c.re.test(src)).map(
    (c) => c.name
  );
  return { score: signals.length, signals, isWorksheet: signals.length >= 2 };
}

// Tesseract accept rule: confidence >= 75 AND structure AND basic quality.
export function isGoodTesseractResult(
  text: string,
  confidence: number
): { ok: boolean; reason: string; structure: WorksheetStructure } {
  const structure = detectWorksheetStructure(text);
  const q = textQuality(text);
  if (!Number.isFinite(confidence) || confidence < 75) {
    return {
      ok: false,
      reason: `tesseract confidence ${confidence} below 75`,
      structure,
    };
  }
  if (!structure.isWorksheet) {
    return {
      ok: false,
      reason: `no worksheet structure (score ${structure.score})`,
      structure,
    };
  }
  if (q.chars < 20 || q.alphaNumRatio < 0.4 || q.longWordCount < 5) {
    return {
      ok: false,
      reason: `ocr text quality too low (chars=${q.chars})`,
      structure,
    };
  }
  return { ok: true, reason: "tesseract fast-pass accepted", structure };
}

// ---------------------------------------------------------------------------
// 3. Normalization: _____ -> [BLANK] (never lowercase [blank]).
// ---------------------------------------------------------------------------

export function normalizeWorksheetText(text: string): string {
  let out = (text || "").replace(/\r\n?/g, "\n");
  // Canonicalize lowercase marker from older prompts -> uppercase [BLANK].
  // ASCII, grep-able; note the unicode box char is NOT used (fragments
  // in the nomic-embed-text tokenizer and drops in some fonts).
  out = out.replace(/\[blank\]/g, BLANK_MARKER);
  // Checkbox glyphs denote choices, not fill-ins -> keep as [ ].
  out = out.replace(/[□▢☐✓✔]/g, " [ ] ");
  // Underscore runs, ellipsis runs, dot leaders -> blank marker.
  out = out.replace(/_{2,}/g, ` ${BLANK_MARKER} `);
  out = out.replace(/…+/g, ` ${BLANK_MARKER} `);
  out = out.replace(/(?:\.\s*){3,}/g, ` ${BLANK_MARKER} `);
  // Collapse whitespace but keep line breaks (question-per-line chunking).
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}
// ---------------------------------------------------------------------------
// 3b. Worksheet -> teaching prose.
//
// Lesson prompts must teach the passage, not the exercises. Feeding the raw
// worksheet chunk made gemma3:1b copy question scaffolding and the picture
// footer ("A HAPPY FAMILY 7") straight into the lesson. Strip scaffolding only
// when the text actually looks like a worksheet, and fall back to the original
// when too little teaching text would survive.
// ---------------------------------------------------------------------------

const SECTION_INSTRUCTION =
  /^(?:[A-Za-z]\s*[.)]\s*)?(?:work\s*sheet\b|read\s+the\s+passage\b|read\b|tick\b|look at\b|look\b|match\b|circle\b|write\b|answer\b|choose\b|fill\b|draw\b|colour\b|color\b)/i;
const SLASH_OPTIONS = /\([^()\n]{1,60}\/[^()\n]{1,60}\)/;
// Line with no lowercase letters at all (headings/footers such as "A HAPPY FAMILY").
const ALL_CAPS_LINE = /^[^a-z]*[A-Z][^a-z]*$/;

function isScaffoldingLine(line: string): boolean {
  if (/^\[image\b/i.test(line)) return true;
  // Trailing exercise block: a passage sentence glued to "A. Tick..." or
  // "1. (.../...)" must be treated as scaffolding even if it starts mid-text.
  const joints = line.split(/\s+(?=[A-E]\.\s+(?:Tick|Look|Match|Circle|Write|Read|Answer|Choose|Fill|Colour|Color|Draw)\b|\d{1,2}\.\s*\()/);
  if (joints.length > 1 && joints.slice(1).every((j) => isScaffoldingLine(j))) {
    const head = joints[0].trim();
    if (SECTION_INSTRUCTION.test(head) || /^\d+\s*[.)]/.test(head)) return true;
    // A passage sentence with a glued exercise tail: drop only when the head
    // is short (worksheet headers, not real teaching prose).
    if (head.split(/\s+/).length <= 10) return true;
  }
  if (SECTION_INSTRUCTION.test(line)) return true;
  if (/^\d{1,3}$/.test(line)) return true;
  // Numbered exercise item: only drop it when it carries exercise markers, so a
  // numbered sentence inside real teaching prose survives.
  if (/^\d+\s*[.)]/.test(line)) {
    if (
      SLASH_OPTIONS.test(line) ||
      /\[BLANK\]|\[blank\]|\[ \]/.test(line) ||
      /\?\s*$/.test(line)
    ) {
      return true;
    }
  }
  if (line.split(/\s+/).length <= 8 && ALL_CAPS_LINE.test(line)) return true;
  return false;
}

export function toTeachingText(context: string): string {
  const src = (context || "").trim();
  if (!src || !detectWorksheetStructure(src).isWorksheet) return src;
  // Chunking flattens newlines, so split BOTH on sentence ends and on common
  // exercise joints (" A.", " 1.", "Parents ..."). This restores one unit per
  // line for the scaffolding filter even when the chunk is a single line.
  const flattened = src
    .replace(/\[image:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const pieces = flattened
    .replace(/([.!?])\s+/g, "$1\n")
    .replace(/\s+(?=[A-E]\.\s+(?:Tick|Look|Match|Circle|Write|Read|Answer|Choose|Fill|Colour|Color|Draw)\b)/g, "\n")
    .replace(/\s+(?=\d{1,2}\.\s*\()/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isScaffoldingLine(line));
  const text = pieces.join("\n").trim();
  return textQuality(text).wordCount >= 20 ? text : src;
}

// ---------------------------------------------------------------------------
// 4. PDF -> JPEG extraction (no native deps; scans SOI..EOI markers).
// ---------------------------------------------------------------------------

export function extractJpegImages(pdf: Buffer): Buffer[] {
  const images: Buffer[] = [];
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

// Images under ~50KB are usually watermark strips / icons: the spike showed
// vision hallucinates whole worksheets from them, so callers must skip/gate.
export function isSkippableImage(buf: Buffer): boolean {
  return buf.length < 50 * 1024;
}

// ---------------------------------------------------------------------------
// 5. Tesseract fast-pass + Ollama vision slow-pass (both local).
// ---------------------------------------------------------------------------

export async function ocrImageBuffer(
  image: Buffer,
  lang = "eng"
): Promise<{ text: string; confidence: number }> {
  // NOTE: tesseract.js resolves its worker script via its own __dirname,
  // which breaks under Next dev on Windows (resolves C:\ROOT\... and the
  // request hangs). Pass an absolute workerPath computed from the project
  // root instead. No new dependency; same local engine as the spike.
  const workerPath = path.join(
    process.cwd(),
    "node_modules",
    "tesseract.js",
    "src",
    "worker-script",
    "node",
    "index.js"
  );
  const worker = await createWorker(lang, undefined, { workerPath });
  try {
    const { data } = await worker.recognize(image);
    return { text: data.text || "", confidence: data.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}

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

export async function visionTranscribeImage(
  image: Buffer,
  model = "gemma3:4b",
  timeoutMs = 180000
): Promise<string> {
  const b64 = image.toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        prompt: VISION_PROMPT,
        images: [b64],
        stream: false,
        options: { temperature: 0, num_predict: 1000, num_ctx: 2048 },
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Ollama vision failed: ${res.status} ${res.statusText}`
      );
    }
    const data = await res.json();
    return (data.response as string) || "";
  } finally {
    clearTimeout(timer);
  }
}
