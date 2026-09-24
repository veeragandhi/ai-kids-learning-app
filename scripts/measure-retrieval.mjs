#!/usr/bin/env node
// Retrieval leakage measurement (investigation tool, not a child path).
//
// Scores every stored chunk for a set of queries using the SAME math as
// lib/retrieval.ts (mirrors getRelevantContext: hybrid 0.7 cosine + 0.3
// lexical, keep cosine >= 0.50 && lexical > 0, topK 3) and simulates the
// Ask evidence-term selection (mirrors bestFactList/pickEvidenceTerm in
// app/api/ask/route.ts). Uses the REAL vectors.json chunks and REAL
// nomic-embed-text embeddings — only the ~40 lines of pure scoring are
// duplicated here. If lib/retrieval.ts scoring changes, update the mirrors.
//
// Usage: node scripts/measure-retrieval.mjs [--json]
// Exit code is nonzero only when the acceptance case (dino leakage) fails.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------- mirrors
// Mirror of IGNORED_WORDS / ATTRIBUTE_WORDS / stemWord / contentTokens /
// cleanRetrievalQuery in lib/retrieval.ts. Keep in sync by hand.
const IGNORED_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "can", "could", "did", "do",
  "does", "for", "from", "give", "how", "in", "is", "it", "just", "me", "of", "on",
  "or", "please", "tell", "the", "their", "them", "then", "there", "they", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "why", "with",
  "you", "your", "alike", "different", "need", "needs", "use", "uses", "using",
]);
const ATTRIBUTE_WORDS = new Set(["color", "colour", "favorite", "favourite", "age", "name", "names"]);

function stemWord(word) {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function contentTokens(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((word) => word.length > 1 && !IGNORED_WORDS.has(word))
    .map(stemWord);
}

function cleanRetrievalQuery(query) {
  return String(query)
    .replace(/\bjust tell me:?\s*/gi, "")
    .replace(/\b(tell me the answer|give me the answer|what is the answer)\b:?\s*/gi, "")
    .trim();
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Mirror of bestFactList support code in app/api/ask/route.ts.
const VAGUE_LIST_WORDS = new Set([
  "several", "thing", "things", "well", "different", "job", "jobs", "way", "ways",
  "rest", "own", "help", "helps", "also",
]);
const ASK_META_WORDS = new Set([
  "think", "thinking", "lesson", "detail", "question", "answer", "clue", "useful",
  "discover", "imagine", "remember", "idea", "ideas", "about",
]);

function answerConceptTokens(text) {
  const aliases = { breathe: "breath", breathing: "breath", breathed: "breath", african: "africa", asian: "asia" };
  return contentTokens(text).map((t) => aliases[t] || t);
}

function extractListItems(text) {
  const lists = [];
  const patterns = [
    /\b(?:need|needs|needed)\s+([^.?!]+)/gi,
    /\b(?:use|uses|used)\s+(?:its\s+\w+\s+)?(?:for\s+)?([^.?!]+)/gi,
    /\blive in\s+([^.?!]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const parts = match[1].split(/,|;|\/|\band\b|\bor\b/i)
        .map((p) => p.replace(/[^a-zA-Z0-9\s]/g, " ").trim())
        .filter((p) => contentTokens(p).filter((t) => !VAGUE_LIST_WORDS.has(t)).length > 0);
      if (parts.length > 0) lists.push(parts);
    }
  }
  return lists;
}

function bestFactList(context, question) {
  const questionTokens = new Set(contentTokens(question));
  const sentences = context.split(/(?<=[.!?])\s+/);
  const ranked = sentences
    .map((sentence, index) => ({
      sentence, index,
      overlap: contentTokens(sentence).filter((t) => questionTokens.has(t)).length,
    }))
    .sort((a, b) => b.overlap - a.overlap);
  const pickLongest = (text) => {
    const lists = extractListItems(text);
    if (lists.length === 0) return [];
    return lists.sort((a, b) => b.length - a.length)[0];
  };
  // Mirror of the relevance gate in bestFactList (app/api/ask/route.ts).
  const GENERIC = new Set(["have","has","had","hav","having","make","makes","made","making","take","takes","took","taking","get","gets","got","getting","give","gives","gave","giving","go","goes","went","going","come","comes","came","coming","do","does","did","don","is","are","was","were","be","can","could","will","would","should","live","liv","like","lik"]);
  const best = ranked.length ? ranked[0].overlap : 0;
  const minOverlap = Math.max(1, best - 1);
  for (const item of ranked) {
    if (item.overlap === 0 || item.overlap < minOverlap) continue;
    if (item.overlap < best) {
      const shared = contentTokens(item.sentence).filter((t) => questionTokens.has(t) && !GENERIC.has(t));
      if (shared.length === 0) continue;
    }
    const list = pickLongest(sentences.slice(item.index, item.index + 2).join(" "));
    if (list.length > 0) return list;
  }
  return [];
}

function findOriginalWord(context, stemmedToken) {
  const match = context.toLowerCase().match(new RegExp(`\\b(\\w*${stemmedToken}\\w*)\\b`, "i"));
  return match ? match[1] : stemmedToken;
}

function pickEvidenceTerm(context, question) {
  const fact = bestFactList(context, question)[0];
  if (fact) {
    const token = contentTokens(fact).find((t) => t.length > 2);
    if (token) return findOriginalWord(context, token);
  }
  const questionTokens = contentTokens(question).filter((t) => !ASK_META_WORDS.has(t));
  const contextTokenList = contentTokens(context);
  const shared = [...questionTokens].reverse().find((t) => contextTokenList.includes(t));
  if (shared) return findOriginalWord(context, shared);
  return "this";
}
// ------------------------------------------------------------ end mirrors

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const MIN_SIMILARITY = 0.50;
const TOP_K = 3;
// Mirror of TOPIC_MARGIN in lib/retrieval.ts.
const TOPIC_MARGIN = 0.10;

async function embed(text) {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

const CASES = [
  { id: "dino-why", query: "Why did Stegosaurus live before T. rex?", expectDocs: ["dinosaurs.txt"], strict: true },
  { id: "forest-fish", query: "Where do fish live?", expectDocs: ["animals.txt"] },
  { id: "trunk-uses", query: "What can an elephant use its trunk for?", expectDocs: ["elephants.txt"] },
  { id: "generic-meet", query: "How do animals meet their needs?", expectDocs: ["animals.txt"] },
  { id: "multi-dino", query: "How are T. rex and Triceratops alike and different?", expectDocs: ["dinosaurs.txt"] },
  { id: "plants-needs", query: "What do plants need to grow?", expectDocs: ["plants.txt"] },
  { id: "plants-sun", query: "Why do plants need sunlight to grow?", expectDocs: ["plants.txt"] },
  { id: "single-token", query: "What do animals need?", expectDocs: ["animals.txt"] },
  { id: "human-trunk", query: "Why don't humans have trunks like elephants?", expectDocs: ["elephants.txt"], note: "honesty gate handles downstream" },
];

const vectorsPath = path.join(process.cwd(), "embeddings", "vectors.json");
const chunks = JSON.parse(await readFile(vectorsPath, "utf8"));
const jsonMode = process.argv.includes("--json");
const report = [];

for (const c of CASES) {
  const retrievalQuery = cleanRetrievalQuery(c.query);
  const queryTokens = contentTokens(retrievalQuery);
  const queryEmbedding = await embed(retrievalQuery);
  const scored = chunks.map((chunk) => {
    const chunkTokenSet = new Set(contentTokens(chunk.text));
    const overlap = queryTokens.filter((t) => chunkTokenSet.has(t));
    const cosine = cosineSimilarity(queryEmbedding, chunk.embedding);
    const lexical = queryTokens.length === 0 ? 0 : overlap.length / queryTokens.length;
    return {
      id: chunk.id.slice(0, 8), doc: chunk.documentName || "unknown",
      preview: chunk.text.slice(0, 70).replace(/\s+/g, " "),
      cosine, lexical, overlap, hybrid: 0.7 * cosine + 0.3 * lexical,
      passFilter: cosine >= MIN_SIMILARITY && lexical > 0,
    };
  });
  scored.sort((a, b) => b.hybrid - a.hybrid);
  scored.forEach((s, i) => { s.rank = i + 1; });
  // Mirror of the TOPIC_MARGIN filter in lib/retrieval.ts.
  const absolute = scored.filter((s) => s.passFilter);
  const topScore = absolute.length > 0 ? absolute[0].hybrid : 0;
  const included = absolute
    .filter((s, i) => i === 0 || topScore - s.hybrid < TOPIC_MARGIN)
    .slice(0, TOP_K);
  const includedDocs = included.map((s) => s.doc);
  const context = included.map((s) => chunks.find((ch) => ch.id.startsWith(s.id)).text).join("\n");
  const evidence = context ? pickEvidenceTerm(context, c.query) : "(no context)";

  const missingExpected = c.expectDocs.filter((d) => !includedDocs.includes(d));
  const unexpectedDocs = includedDocs.filter((d) => !c.expectDocs.includes(d));
  const result = {
    id: c.id, query: c.query, queryTokens,
    chunks: scored.map((s) => ({
      rank: s.rank, doc: s.doc,
      cosine: Number(s.cosine.toFixed(3)), lexical: Number(s.lexical.toFixed(3)),
      overlap: s.overlap, hybrid: Number(s.hybrid.toFixed(3)),
      included: included.includes(s), preview: s.preview,
    })),
    includedDocs, evidence,
    missingExpected, unexpectedDocs,
    leak: unexpectedDocs.length > 0,
  };
  if (c.id === "dino-why") {
    result.acceptance =
      missingExpected.length === 0 &&
      unexpectedDocs.length === 0 &&
      !/forest/i.test(evidence);
  }
  report.push(result);

  if (!jsonMode) {
    console.log(`\n=== ${c.id}: "${c.query}"`);
    console.log(`    queryTokens=[${queryTokens.join(", ")}]`);
    for (const s of result.chunks) {
      console.log(`    ${s.rank}. ${s.doc} cosine=${s.cosine} lexical=${s.lexical} overlap=[${s.overlap.join(", ")}] hybrid=${s.hybrid} included=${s.included}`);
      console.log(`       "${s.preview}..."`);
    }
    console.log(`    includedDocs=[${includedDocs.join(", ")}] evidence="${evidence}"`);
    console.log(`    missingExpected=[${missingExpected.join(", ")}] unexpected=[${unexpectedDocs.join(", ")}]${c.id === "dino-why" ? ` ACCEPTANCE=${result.acceptance ? "PASS" : "FAIL"}` : ""}`);
  }
}

if (jsonMode) {
  console.log(JSON.stringify({ baseUrl: OLLAMA_BASE_URL, model: OLLAMA_EMBED_MODEL, cases: report }, null, 2));
} else {
  const leaks = report.filter((r) => r.leak);
  console.log(`\nSummary: ${report.length} cases, ${leaks.length} with unexpected docs: ${leaks.map((r) => r.id).join(", ") || "none"}`);
}
const dino = report.find((r) => r.id === "dino-why");
process.exitCode = dino && dino.acceptance ? 0 : 1;
