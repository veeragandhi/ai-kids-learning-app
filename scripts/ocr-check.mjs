// scripts/ocr-check.mjs — offline unit checks for lib/ocr pure functions.
// No Ollama, no Tesseract, no Next server. Run: node scripts/ocr-check.mjs
// Mirrors the TS logic in JS (kept dependency-free on purpose) so the
// quality gates can be validated without a TS runtime.

import fs from "fs";
import path from "path";

function textQuality(text) {
  const raw = text || "";
  const chars = raw.trim().length;
  const total = raw.replace(/\s/g, "").length;
  const alphaNum = (raw.match(/[A-Za-z0-9]/g) || []).length;
  const words = raw.split(/\s+/).filter(Boolean);
  const longWordCount = words.filter((w) => /[A-Za-z0-9]{3,}/.test(w)).length;
  return { chars, alphaNumRatio: total === 0 ? 0 : alphaNum / total, wordCount: words.length, longWordCount };
}

function isGoodTextLayer(text) {
  const q = textQuality(text);
  return q.chars >= 20 && q.alphaNumRatio >= 0.5 && q.longWordCount >= 5;
}

const CHECKS = [
  { name: "numbered-questions", re: /(?:^|\n)\s*(?:Q\.?\s?\d+|\d+\s*[.)]\s)/im },
  { name: "question-mark", re: /\?/ },
  { name: "lettered-options", re: /(?:^|\n)\s*[A-E]\s*[.)]/im },
  { name: "slash-options", re: /\([^()\n]{1,60}\/[^()\n]{1,60}\)/ },
  { name: "blanks", re: /_{2,}|…{1,}|\.{3,}|\[BLANK\]|\[blank\]/ },
  { name: "name-field", re: /\bName\s*:/i },
  { name: "date-field", re: /\bDate\s*:/i },
  { name: "page-marker", re: /\bPage\s*\d+/i },
  { name: "instruction-verb", re: /\b(Tick|Match|Circle|Write|Read|Answer|Choose|Fill|Look at)\b/i },
];

function detectWorksheetStructure(text) {
  const signals = CHECKS.filter((c) => c.re.test(text || "")).map((c) => c.name);
  return { score: signals.length, signals, isWorksheet: signals.length >= 2 };
}

function normalizeWorksheetText(text) {
  let out = (text || "").replace(/\r\n?/g, "\n");
  out = out.replace(/\[blank\]/g, "[BLANK]");
  out = out.replace(/[□▢☐✓✔]/g, " [ ] ");
  out = out.replace(/_{2,}/g, " [BLANK] ");
  out = out.replace(/…+/g, " [BLANK] ");
  out = out.replace(/(?:\.\s*){3,}/g, " [BLANK] ");
  out = out.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// Mirrors toTeachingText() / isScaffoldingLine() in lib/ocr.ts.
const SECTION_INSTRUCTION =
  /^(?:[A-Za-z]\s*[.)]\s*)?(?:work\s*sheet\b|read\s+the\s+passage\b|read\b|tick\b|look at\b|look\b|match\b|circle\b|write\b|answer\b|choose\b|fill\b|draw\b|colour\b|color\b)/i;
const SLASH_OPTIONS = /\([^()\n]{1,60}\/[^()\n]{1,60}\)/;

function isScaffoldingSentence(sentence) {
  const s = sentence.trim();
  if (!s) return true;
  if (/^\[image\b/i.test(s)) return true;
  const joints = s.split(/\s+(?=[A-E]\.\s+(?:Tick|Look|Match|Circle|Write|Read|Answer|Choose|Fill|Colour|Color|Draw)\b|\d{1,2}\.\s*\()/);
  if (joints.length > 1 && joints.slice(1).every((j) => isScaffoldingSentence(j))) {
    const head = joints[0].trim();
    if (SECTION_INSTRUCTION.test(head) || /^\d+\s*[.)]/.test(head)) return true;
    if (head.split(/\s+/).length <= 10) return true;
  }
  if (SECTION_INSTRUCTION.test(s)) return true;
  if (/^\d{1,3}$/.test(s)) return true;
  if (SLASH_OPTIONS.test(s)) return true;
  if (/^\d+\s*[.)]/.test(s)) {
    if (/\[BLANK\]|\[blank\]|\[ \]/.test(s) || /\?\s*$/.test(s)) return true;
  }
  if (s.split(/\s+/).length <= 8 && !/[a-z]/.test(s)) return true;
  return false;
}

function toTeachingText(context) {
  const src = (context || "").trim();
  if (!src || !detectWorksheetStructure(src).isWorksheet) return src;
  const flattened = src
    .replace(/\[image:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const kept = flattened
    .replace(/([.!?])\s+/g, "$1\n")
    .replace(/\s+(?=[A-E]\.\s+(?:Tick|Look|Match|Circle|Write|Read|Answer|Choose|Fill|Colour|Color|Draw)\b)/g, "\n")
    .replace(/\s+(?=\d{1,2}\.\s*\()/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isScaffoldingSentence(s));
  const text = kept.join("\n").trim();
  return textQuality(text).wordCount >= 20 ? text : src;
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
}

// 1. text layer: good printed text passes
check("good-text-layer", isGoodTextLayer("Father, mother and children make a family. A small family has one or two children."));
// 2. text layer: 20+ chars of punctuation junk rejected
check("garbage-layer-rejected", !isGoodTextLayer("... --- ... ___ ... ::: ... ??? ... ###"));
// 3. text layer: empty scan rejected
check("empty-layer-rejected", !isGoodTextLayer("   \n  "));
// 4. structure: worksheet with Q numbers + options detected
const ws = detectWorksheetStructure("1. (Father / Uncles) make a family?\n2. Tick the correct answer.");
check("worksheet-detected", ws.isWorksheet && ws.score >= 2, JSON.stringify(ws));
// 5. structure: plain prose is not a worksheet
check("prose-not-worksheet", !detectWorksheetStructure("The cat sat on the warm mat near the window.").isWorksheet);
// 6. normalization: underscore runs -> [BLANK]
check("blanks-normalized", normalizeWorksheetText("Fill _____ and ______ here.").includes("[BLANK]") && !normalizeWorksheetText("Fill _____ here.").includes("_____"));
// 7. normalization: canonical uppercase, no lowercase leak
check("blank-uppercase", !normalizeWorksheetText("a [blank] b ___ c").includes("[blank]"));
// 8. normalization: checkbox glyphs do not become blanks
check("checkbox-not-blank", normalizeWorksheetText("Tick □ A □ B").includes("[ ]") && !normalizeWorksheetText("Tick □ A").includes("[BLANK]"));
// 9. spike regression: vision transcript shape passes layer gate
check("vision-sample-passes", isGoodTextLayer("WORK SHEET 1 READ AND UNDERSTAND Read the passage and answer the questions that follow. Father, mother and children make a family."));

// 10-13. toTeachingText: lesson/quiz context must be prose, not exercises.
function realWorksheetChunk() {
  try {
    const vectors = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "embeddings", "vectors.json"), "utf-8")
    );
    const chunk = vectors.find((c) => c.documentName === "IraWorksheet.txt");
    return chunk ? chunk.text : null;
  } catch {
    return null;
  }
}

const worksheetChunk = realWorksheetChunk();
if (worksheetChunk) {
  const teaching = toTeachingText(worksheetChunk);
  check(
    "teaching-text-drops-scaffolding",
    !/work\s*sheet/i.test(teaching) && !/tick/i.test(teaching) && !/\[ \]/.test(teaching),
    teaching.slice(0, 120)
  );
  check("teaching-text-drops-picture-caption", !/\[image/i.test(teaching));
  check(
    "teaching-text-drops-option-groups",
    !/\([^()\n]{1,60}\/[^()\n]{1,60}\)/.test(teaching) && !/happy family/i.test(teaching),
    teaching.split("\n").slice(-2).join(" | ")
  );
  check(
    "teaching-text-keeps-passage",
    /small family/i.test(teaching) &&
      /joint family/i.test(teaching) &&
      /uncles/i.test(teaching) &&
      teaching.split(/\s+/).length >= 60,
    `words=${teaching.split(/\s+/).length}`
  );
  check(
    "teaching-text-single-line-becomes-lines",
    teaching.split("\n").length >= 5
  );
} else {
  check("teaching-text-real-chunk-available", false, "IraWorksheet.txt not in vectors.json");
}

// 14. Non-worksheet prose must pass through untouched.
const prose = "Plants need water, sunlight and air to grow. Roots take in water from the soil.";
check("teaching-text-leaves-prose-untouched", toTeachingText(prose) === prose);

console.log(`\n${pass} passed, ${fail} failed`);

// --show-teaching prints the real worksheet chunk and what toTeachingText keeps,
// which is what the lesson/quiz prompts now receive.
if (process.argv.includes("--show-teaching") && worksheetChunk) {
  console.log("\n--- raw stored chunk (first 400 chars) ---");
  console.log(worksheetChunk.slice(0, 400));
  console.log("\n--- toTeachingText() output ---");
  console.log(toTeachingText(worksheetChunk));
}

process.exit(fail ? 1 : 0);
