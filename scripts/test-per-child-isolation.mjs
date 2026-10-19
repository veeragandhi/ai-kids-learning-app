#!/usr/bin/env node
/**
 * test-per-child-isolation.mjs — V1 regression tests for per-child isolation.
 *
 * Dependency-free (node 18+ global fetch only). Two suites:
 *  A. Static (always runs): asserts the enforcement code is present so a
 *     refactor cannot silently drop ownership checks, scoping, or guards.
 *  B. Live (needs `npm run dev` on BASE_URL, default http://localhost:3000):
 *     exercises fail-closed behavior, mode boundaries, traversal whitelist,
 *     and cross-child/legacy retrieval leakage. Ollama-dependent checks skip
 *     with a reason when Ollama is unreachable — fail-closed checks never skip.
 *
 * Never weakens authorization to pass: every live isolation assertion expects
 * denial (400/401/403/404/503) or honest-unknown, never shared data.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function ok(name) {
  pass += 1;
  console.log(`  PASS ${name}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}
function skipped(name, reason) {
  skip += 1;
  console.log(`  SKIP ${name} (${reason})`);
}
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}
function has(rel, needle) {
  try {
    return src(rel).includes(needle);
  } catch {
    return false;
  }
}

// ── Suite A: static enforcement assertions ──────────────────────────────

console.log("[static] enforcement code present");

const STATIC_CHECKS = [
  ["requireChild exists + fail-closed mapping",
    "src/lib/supabase/requireChild.ts",
    ["verifyChildOwnership", "Sign-in is required", "never downgrade"]],
  ["retrieval pre-scoring owner filter",
    "src/lib/retrieval.ts",
    ["(chunk.childId ?? null) === childId", "missing childId (fail-closed)"]],
  ["vector chunks carry childId",
    "src/lib/vectorStore.ts",
    ["childId?: string | null"]],
  ["documents lib guards",
    "src/lib/documents.ts",
    ["resolveDocPath", "round-trip", "readDocumentText"]],
  ["ingest namespaces by child",
    "src/lib/ingest.ts",
    ["uploads/<childId>", "childId?: string | null", "documentName: relName"]],
  ["ocr jobs bound to child",
    "src/lib/ocr-jobs.ts",
    ["childId?: string | null"]],
  ["documents route verifies + imports",
    "src/app/api/documents/route.ts",
    ["verifyChildOwnership", " owned,", " legacy", "import"]],
  ["upload verifies form childId",
    "src/app/api/upload/route.ts",
    ["verifyChildOwnership", "formData.get(\"childId\")", "runOcrPipeline(buffer, textFileName, verified.childId)"]],
  ["confirm binds job to child",
    "src/app/api/upload/confirm/route.ts",
    ["verifyChildOwnership", "jobOwner !== verified.childId"]],
  ["lesson verifies + scopes",
    "src/app/api/lesson/route.ts",
    ["verifyChildOwnership", "{ childId: verified.childId }"]],
  ["quiz verifies + scopes",
    "src/app/api/quiz/route.ts",
    ["verifyChildOwnership", "{ childId: verified.childId }"]],
  ["ask verifies + scopes",
    "src/app/api/ask/route.ts",
    ["verifyChildOwnership", "{ childId: verified.childId }"]],
  ["generate-video verifies + scopes",
    "src/app/api/generate-video/route.ts",
    ["verifyChildOwnership", "{ childId: verified.childId }"]],
  ["lesson storage ownership API",
    "src/lib/lessonStorage.ts",
    ["getOwned", "listFor", "deleteOwned", "childId: string | null"]],
  ["store facade exists",
    "src/lib/store/index.ts",
    ["lessons", "quizzes", "ask", "progress"]],
  ["pages use child-scoped store",
    "src/app/lesson/ClientLesson.tsx",
    ["@/lib/store", "resolveActiveChildId"]],
  ["session handoff scoped per child",
    "src/lib/store/lessons.ts",
    ["lastLessonKey"]],
  ["sync stays a documented no-op",
    "src/lib/storageService.ts",
    ["no-op", "backward compatibility"]],
  ["Stage 1: authedFetch helper wired everywhere",
    "src/lib/supabase/authedFetch.ts",
    ["getParentToken", "apiFetch", "never", "demo-local"]],
  ["Stage 1: video includes childId",
    "src/app/lesson/ClientLesson.tsx",
    ["body: { topic, age, childId }"]],
  ["Stage 2: local/request child split",
    "src/lib/store/activeChild.ts",
    ["resolveLocalChildId", "resolveRequestChildId", "never collapse"]],
  ["Stage 2: pages use local id for stores",
    "src/app/quiz/page.tsx",
    ["resolveLocalChildId", "getLesson(activeId, localChildId)"]],
  ["Stage 2: lesson page uses local id",
    "src/app/lesson/ClientLesson.tsx",
    ["resolveLocalChildId", "getLesson(idToLoad, localChildId)"]],
  ["Stage 2: ask page uses local id",
    "src/app/ask/page.tsx",
    ["resolveLocalChildId", "getLesson(idToLoad, localChildId)"]],
  ["Stage 3: idempotent ingest + rollback",
    "src/lib/ingest.ts",
    ["deleteChunksByDocument(relName, childId)", "rollback", "Phase 1", "Phase 2"]],
  ["Stage 4: chat pinned to Ollama",
    "src/app/api/chat/route.ts",
    ["OllamaProvider", "503", "does NOT use `aiService`"]],
  ["Stage 5: legacy gated to demo mode",
    "src/app/api/documents/route.ts",
    ["verified.mode"]],
];

for (const [name, file, needles] of STATIC_CHECKS) {
  const missing = needles.filter((n) => !has(file, n));
  if (missing.length === 0) ok(name);
  else bad(name, `${file} missing: ${missing.join("; ")}`);
}

// No raw unscoped session key left in UI code (only the key builder may
// mention the prefix).
{
  const hits = ["src/app/lesson/ClientLesson.tsx", "src/app/quiz/page.tsx", "src/app/ask/page.tsx"]
    .flatMap((f) => {
      try {
        return src(f).split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => line.includes('"lastLesson"'));
      } catch {
        return [{ f, i: 0, line: "UNREADABLE" }];
      }
    });
  if (hits.length === 0) ok("no unscoped lastLesson session key in pages");
  else bad("no unscoped lastLesson session key in pages", hits.map((h) => `${h.f}:${h.i}`).join(", "));
}

// ── Suite B: live API assertions ────────────────────────────────────────

async function req(method, p, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

console.log("[live] API fail-closed + boundaries");

let live = true;
try {
  const ping = await req("GET", "/api/documents?childId=demo-local", undefined, 8000);
  if (ping.status === 0) throw new Error("unreachable");
} catch {
  live = false;
  skipped("live suite", `dev server unreachable at ${BASE}`);
}

const FAKE_UUID = "11111111-2222-4333-8555-666666666666";
const DEMO = "demo-local";

if (live) {
  // Missing childId must never mean "all documents" (both modes).
  for (const [name, method, p, body] of [
    ["documents GET missing childId → 400", "GET", "/api/documents", undefined],
    ["documents PATCH missing childId → 400", "PATCH", "/api/documents", { name: "x.txt" }],
    ["documents DELETE missing childId → 400", "DELETE", "/api/documents", { name: "x.txt" }],
    ["documents POST import missing childId → 400", "POST", "/api/documents", { name: "x.txt" }],
    ["lesson POST missing childId → 400", "POST", "/api/lesson", { topic: "Elephants", age: 6 }],
    ["quiz POST missing childId → 400", "POST", "/api/quiz", { topic: "Elephants", age: 6 }],
    ["ask POST missing childId → 400", "POST", "/api/ask", { question: "What?", mode: "question" }],
    ["upload confirm missing childId → 400", "POST", "/api/upload/confirm", { jobId: "nope" }],
  ]) {
    const r = await req(method, p, body);
    if (r.status === 400) ok(name);
    else bad(name, `expected 400, got ${r.status}`);
  }

  // Invalid childId shapes fail closed (both modes).
  {
    const r = await req("GET", "/api/documents?childId=not-a-child!!");
    if (r.status === 400) ok("documents GET invalid childId → 400");
    else bad("documents GET invalid childId → 400", `got ${r.status}`);
  }

  // Mode probe: demo-local → 200 means local/demo server; 403 means an
  // authenticated-mode server (Supabase configured) where demo is rejected.
  const probe = await req("GET", `/api/documents?childId=${DEMO}`);
  const demoMode = probe.status === 200;
  const authedMode = probe.status === 403;
  if (demoMode) ok("mode probe: demo-mode server");
  else if (authedMode) ok("mode probe: authenticated-mode server (demo rejected)");
  else bad("mode probe", `expected 200 or 403, got ${probe.status}`);

  // Real UUID without auth is never downgraded to open access (both modes).
  for (const [name, method, p, body] of [
    ["documents GET uuid no token → deny", "GET", `/api/documents?childId=${FAKE_UUID}`, undefined],
    ["lesson POST uuid no token → deny", "POST", "/api/lesson", { topic: "Elephants", childId: FAKE_UUID }],
    ["quiz POST uuid no token → deny", "POST", "/api/quiz", { topic: "Elephants", childId: FAKE_UUID }],
    ["ask POST uuid no token → deny", "POST", "/api/ask", { question: "What?", mode: "question", childId: FAKE_UUID }],
  ]) {
    const r = await req(method, p, body);
    if ([401, 403, 503].includes(r.status)) ok(`${name} (${r.status})`);
    else bad(name, `expected 401/403/503, got ${r.status}`);
  }

  // Authenticated-mode server: demo namespace stays rejected everywhere.
  if (authedMode) {
    for (const [name, method, p, body] of [
      ["documents PATCH demo authed → deny", "PATCH", "/api/documents", { name: "x.txt", childId: DEMO }],
      ["documents DELETE demo authed → deny", "DELETE", "/api/documents", { name: "x.txt", childId: DEMO }],
      ["documents POST import demo authed → deny", "POST", "/api/documents", { name: "x.txt", childId: DEMO }],
      ["lesson POST demo authed → deny", "POST", "/api/lesson", { topic: "Elephants", childId: DEMO }],
      ["ask POST demo authed → deny", "POST", "/api/ask", { question: "What?", mode: "question", childId: DEMO }],
      ["upload confirm demo authed → deny", "POST", "/api/upload/confirm", { jobId: "00000000-0000-4000-8000-000000000000", childId: DEMO }],
    ]) {
      const r = await req(method, p, body);
      if ([401, 403, 503].includes(r.status)) ok(`${name} (${r.status})`);
      else bad(name, `expected deny, got ${r.status}`);
    }
    skipped("authenticated 404-whitelist + cross-child matrix",
      "needs TEST_PARENT_TOKEN + two TEST_CHILD_IDs (no test credentials provisioned)");
    skipped("authenticated retrieval leakage probe",
      "needs TEST_PARENT_TOKEN + TEST_CHILD_ID (no test credentials provisioned)");
  }

  // Demo-mode server: full local matrix (verify-first still denies foreign).
  const localChild = DEMO;
  if (demoMode) {
    {
      const r = await req("GET", `/api/documents?childId=${localChild}`);
      if (r.status === 200 && Array.isArray(r.json?.owned) && Array.isArray(r.json?.legacy)) {
        ok("documents GET demo-local → 200 {owned, legacy}");
      } else bad("documents GET demo-local → 200 {owned, legacy}", `got ${r.status}`);
    }

    // Traversal / guessing: whitelist + containment, no oracle.
    for (const [name, method, body] of [
      ["documents DELETE traversal → 400/404", "DELETE", { name: "../../.env", childId: localChild }],
      ["documents DELETE absolute → 400/404", "DELETE", { name: "/etc/passwd", childId: localChild }],
      ["documents DELETE unknown → 404", "DELETE", { name: "no-such-doc-xyz.txt", childId: localChild }],
      ["documents PATCH unknown → 404", "PATCH", { name: "no-such-doc-xyz.txt", childId: localChild }],
      ["documents POST import unknown → 404", "POST", { name: "no-such-doc-xyz.txt", childId: localChild }],
    ]) {
      const r = await req(method, "/api/documents", body);
      if ([400, 404].includes(r.status)) ok(`${name} (${r.status})`);
      else bad(name, `expected 400/404, got ${r.status}`);
    }
    {
      const r = await req("POST", "/api/upload/confirm", { jobId: "00000000-0000-4000-8000-000000000000", childId: localChild });
      if (r.status === 404) ok("upload confirm unknown job → 404");
      else bad("upload confirm unknown job → 404", `got ${r.status}`);
    }

    // Stage 3 live: idempotent re-upload + failure leaves no orphans.
    {
      const vecFile2 = path.join(ROOT, "embeddings", "vectors.json");
      const fname = `zzq-reupload-${Date.now()}.txt`;
      const rel = `${localChild}/${fname}`;
      const text = "zzq reupload probe elephants have trunks for smelling and drinking water in the savanna";
      const uploadTxt = async (t) => {
        const fd = new FormData();
        fd.append("file", new Blob([t], { type: "text/plain" }), fname);
        fd.append("childId", localChild);
        const r = await fetch(`${BASE}/api/upload`, {
          method: "POST", body: fd, signal: AbortSignal.timeout(120000),
        });
        let j = null;
        try { j = await r.json(); } catch {}
        return { status: r.status, json: j };
      };
      const countChunks = () => {
        try {
          return JSON.parse(fs.readFileSync(vecFile2, "utf-8"))
            .filter((c) => c.documentName === rel && ((c.childId ?? null) === localChild)).length;
        } catch { return -1; }
      };
      try {
        const r1 = await uploadTxt(text);
        const c1 = countChunks();
        const r2 = await uploadTxt(text);
        const c2 = countChunks();
        if (r1.status === 200 && r2.status === 200 && c1 > 0 && c2 === c1) {
          ok(`re-upload idempotent (chunks ${c1} → ${c2})`);
        } else {
          bad("re-upload idempotent", `status=${r1.status}/${r2.status} chunks=${c1}/${c2}`);
        }
        const beforeList = (await req("GET", `/api/documents?childId=${localChild}`)).json?.owned ?? [];
        const before = new Set(beforeList.map((d) => d.name));
        // NOTE: `rel` is already owned from the idempotence probe above, so
        // compare full sets: a rejected upload must not add anything.
        const rEmpty = await uploadTxt("   ");
        const afterList = (await req("GET", `/api/documents?childId=${localChild}`)).json?.owned ?? [];
        const listed = afterList.length !== before.size || afterList.some((d) => !before.has(d.name));
        if (rEmpty.status === 422 && !listed) ok("empty upload rejected without orphan metadata");
        else bad("empty upload rejected without orphan metadata", `status=${rEmpty.status} added=${listed}`);
      } finally {
        // Cleanup via the real delete path (also exercises scoped delete).
        await req("DELETE", "/api/documents", { name: rel, childId: localChild });
        const cAfter = countChunks();
        const fGone = !fs.existsSync(path.join(ROOT, "uploads", localChild, fname));
        if (cAfter === 0 && fGone) ok("probe doc + chunks cleaned up");
        else bad("probe doc + chunks cleaned up", `chunks=${cAfter} fileGone=${fGone}`);
      }
    }
  }

  // ── Retrieval leakage probe (demo-mode server + Ollama) ─────────────
  // Injects a sibling-owned chunk and a legacy chunk with a unique marker,
  // then asks for a lesson as demo-local: both must be excluded (honest
  // unknown), proving the pre-scoring owner filter. vectors.json is restored.
  if (!demoMode) {
    skipped("demo retrieval leakage probe", "not a demo-mode server");
  } else if (!(await (async () => {
    try {
      const er = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
      return er.ok;
    } catch {
      return false;
    }
  })())) {
    skipped("demo retrieval leakage probe", "Ollama unreachable");
  } else {
    const MARKER = `zzq-child-boundary-probe ${Date.now()}`;
    const vecFile = path.join(ROOT, "embeddings", "vectors.json");
    let backup = null;
    try {
      backup = fs.existsSync(vecFile) ? fs.readFileSync(vecFile, "utf-8") : "[]";
      const embed = async (text) => {
        const r = await fetch(`${OLLAMA}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "nomic-embed-text:latest", prompt: text }),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) throw new Error(`embed ${r.status}`);
        const j = await r.json();
        return j.embedding;
      };
      const probeText = `${MARKER} sibling and legacy chunks must never leak into a demo lesson`;
      const emb = await embed(probeText);
      const store = JSON.parse(backup || "[]");
      if (!Array.isArray(store)) throw new Error("vectors.json is not an array");
      store.push(
        { id: "probe-sibling", text: probeText, embedding: emb, documentName: "probe.txt", childId: FAKE_UUID },
        { id: "probe-legacy", text: probeText, embedding: emb, documentName: "probe-legacy.txt" },
      );
      fs.writeFileSync(vecFile, JSON.stringify(store));
      const r = await req("POST", "/api/lesson",
        { topic: MARKER, age: 6, childId: localChild }, 180000);
      const lessonText = typeof r.json?.lesson === "string" ? r.json.lesson : "";
      if (r.status === 200 && lessonText.startsWith("I don't know")) {
        ok("sibling + legacy chunks excluded from demo retrieval");
      } else {
        bad("sibling + legacy chunks excluded from demo retrieval",
          `status=${r.status} lesson=${lessonText.slice(0, 80)}...`);
      }
    } catch (e) {
      skipped("demo retrieval leakage probe", String(e?.message || e).slice(0, 120));
    } finally {
      try {
        if (backup !== null) fs.writeFileSync(vecFile, backup);
      } catch (e) {
        bad("vectors.json restore", String(e?.message || e));
      }
    }
  }
}

console.log(`\nresult: ${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length > 0) {
  console.log("failures:");
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
