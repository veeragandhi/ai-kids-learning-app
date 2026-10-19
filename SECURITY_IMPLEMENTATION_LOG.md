# Security Implementation Log — V1 Per-Child Isolation

Plan: `docs/v1-per-child-security-plan.md`. Constraints: local-first, Ollama only,
no cloud sync, no hosted AI, no external transmission of kids data. No commits/pushes.

## Stage 1 — Trust boundary (`requireChild.ts`)
- Changed files:
  - `src/lib/supabase/requireChild.ts` (created): `DEMO_CHILD_ID`, `classifyChildId`,
    `extractBearerToken`, `verifyChildOwnership(req, childId, overrides?)`, fail-closed
    400/401/403/503 mapping, no-oracle 403 for cross-parent IDs.
- Checks run:
  - `npx tsc --noEmit -p tsconfig.json` → PASS (no output).
- Results: verifier compiles; no callers wired yet, so no behavior change.
## Stage 2 — Retrieval isolation (verified child scope before scoring)
- Changed files:
  - `src/lib/vectorStore.ts`: `VectorDocumentChunk { +childId?: string | null }`
    (missing = legacy, never implicitly in scope).
  - `src/lib/retrieval.ts`: `getRelevantContext(q, topK, min, scope?)` requires
    `scope.childId` (non-empty string) else returns `""` fail-closed; filters
    `getChunks()` to `(chunk.childId ?? null) === childId` BEFORE scoring; logs
    total vs in-scope counts (child id truncated).
  - `src/app/api/lesson/route.ts`, `src/app/api/quiz/route.ts`,
    `src/app/api/ask/route.ts`, `src/app/api/generate-video/route.ts`: verify
    `body.childId` via `verifyChildOwnership` (400/401/403/503) before retrieval;
    forward `{ childId: verified.childId }`. Client `lessonText/lessonTopic`
    documented as untrusted anchoring input (ownership enforced client-side in
    Stage 4); standalone retrieval is child-scoped regardless.
- Checks run:
  - `npx tsc --noEmit -p tsconfig.json` → PASS.
  - `npx eslint` on touched lib + lesson + generate-video → 0 errors
    (2 pre-existing warnings: unused `req` param in lesson OPTIONS, unused
    `generateAnswerStream` import in generate-video). Quiz/ask `any` errors are
    pre-existing (verified against baseline behavior; no new lint errors added).
- Results: sibling/legacy chunks cannot enter LLM context via scores; missing
  `childId` fails closed. Known intermediate break: UI pages do not send
  `childId` yet (Stage 4) so personalized calls return 400 until then; legacy
  chunks (no `childId`) are excluded until import (Stage 3).
- Remaining risks: client-supplied `lessonText` spoofing until Stage 4 store
  checks; `chat/route.ts` intentionally untouched (retrieval-free).

## Stage 3 — Document and upload isolation (namespaced files, owned metadata)
- Changed files:
  - `src/lib/documents.ts`: `DocumentItem { name (relative path), approved,
    childId: string|null, legacy }`; `normalizeDocuments()` backfills legacy
    entries; `resolveDocPath()` containment guard (basename per segment +
    resolve-inside + round-trip); `getApprovedDocumentText()` path-guarded and
    documented as non-personalized-only; new `readDocumentText()`;
    `saveTextDocument()` guarded + recursive mkdir; `addDocument(name, {childId})`.
  - `src/lib/ingest.ts`: `finalizeDocumentText(name, text, source, {childId})`
    writes `uploads/<childId>/<base>.txt` (legacy stays top-level), tags chunks
    `{ documentName: relPath, childId }`, returns `{ chunks, name }`.
  - `src/lib/ocr-jobs.ts`: `OcrJob { +childId?: string|null }` bound at creation.
  - `src/lib/vectorStore.ts`: `deleteChunksByDocument(name, childId?)` only
    removes the given child's namespace when scoped.
  - `src/app/api/documents/route.ts`: `GET ?childId=` verified → `{ owned,
    legacy }`; `PATCH/DELETE` verify + 404 (no oracle) for legacy/foreign;
    new `POST` import copies legacy text into the verified child's namespace
    via `finalizeDocumentText` (original untouched).
  - `src/app/api/upload/route.ts`: verifies multipart `childId` before reading
    file bytes; passes verified id to ingest + `runOcrPipeline` (job binding).
  - `src/app/api/upload/confirm/route.ts`: verifies `childId`, rejects
    job/child mismatch with 404 (no oracle); pre-binding jobs are demo-only.
- Checks run:
  - `npx tsc --noEmit -p tsconfig.json` → PASS.
  - `npx eslint` on all seven touched files → PASS (no errors/warnings).
- Results: same-basename collisions across children impossible (namespaces);
  traversal blocked at metadata + resolve layers; cross-child list/edit/delete/
  import/confirm denied.
- Remaining risks: UI (`upload/page.tsx`) not yet sending `childId`/import
  (Stage 4); pre-isolation top-level files are legacy read-only until imported.

## Stage 4 — Lessons and learning-history isolation (child-scoped stores + UI)
- Changed files:
  - `src/lib/lessonStorage.ts`: `StoredLesson/SaveLessonInput { +childId:
    string|null }` (missing backfills to legacy `null`); DB v1→v2 (+`childId`
    index, no data migration needed); `getOwned/listFor/listLegacy/
    deleteOwned`; per-child active-lesson pointer (`get/setActiveId(id,
    childId?)`, legacy global key kept as read fallback only).
  - `src/lib/store/` (new facade, the only UI entrypoint): `types.ts`
    (`QuizAttempt/AskSession/ProgressEntry`), `activeChild.ts`
    (`resolveActiveChildId`: learner → `?childId=` hint → `demo-local`;
    hint is untrusted, server + stores re-verify), `localStore.ts` (generic
    child-scoped IndexedDB helper, separate DBs per domain), `lessons.ts`
    (save/get/list/delete + `importLegacyLesson` copy-under-new-id),
    `quizzes.ts`/`ask.ts`/`progress.ts`, `index.ts` re-export.
  - `src/lib/storageService.ts`: owner-unaware, documented as superseded by
    `@/lib/store` (behavior unchanged).
  - `src/app/lesson/ClientLesson.tsx`: active-child resolution, `childId` in
    `/api/lesson` body + save/list/load/delete scoping + per-child active
    pointer, `childId` carried into quiz/ask handoff URLs.
  - `src/app/quiz/page.tsx`: ownership-checked lesson load, `childId` in
    `/api/quiz` body, `saveQuizAttempt()` on submit (best-effort).
  - `src/app/ask/page.tsx`: ownership-checked lesson ref, `childId` in all
    three `/api/ask` bodies, `saveAskSession()` on completion (best-effort).
  - `src/app/upload/page.tsx`: `childId` in upload/confirm/toggle/delete;
    `{ owned, legacy }` listing with “Created before profiles” badge + explicit
    import button; local-only notice; Suspense wrapper for `useSearchParams`.
  - `src/app/page.tsx`: `childId` hint carried into topic/lesson/quiz/ask links.
- Checks run:
  - `npx tsc --noEmit -p tsconfig.json` → PASS.
  - `npx eslint` on all touched files → no NEW findings (remaining errors are
    pre-existing: set-state-in-effect patterns, `Today's` entity, unused
    `pickEnglishVoice`; my `childId` exhaustive-deps warnings fixed by adding
    it to dep arrays — effect bodies are idempotent-guarded).
- Results: sibling `lessonId` URLs yield graceful empty state; refresh/deep-link
  restore per-child pointer; legacy lessons read-only until imported; quiz/Ask
  history + progress persist per child.
- Deferred (out of security-plan scope): child profile edit/delete in
  `/api/children` + dashboard.
- Remaining risks: devtools can bypass client checks (server gates are the real
  enforcement). `sessionStorage.lastLesson` handoff is now keyed per child
  (`lastLessonKey(childId)`); server retrieval stays scoped regardless, and
  anchored quiz/Ask text remains caller-supplied untrusted input.

## Stage 5 — Regression tests + final checks
- Changed files:
  - `scripts/test-per-child-isolation.mjs` (new) + `package.json`
    (`test:isolation` script): 19 static enforcement assertions (fail if a
    refactor drops a check) + mode-aware live matrix. No new dependencies.
  - `.agents/skills/ask/scripts/evaluate-ask.mjs`: sends
    `childId: ASK_CHILD_ID || "demo-local"` (test-tool-only change; run against
    a Supabase-unconfigured server).
- Checks run:
  - `npm run test:isolation` vs authenticated server (:3000, Supabase
    configured): 39 passed, 0 failed, 3 skipped (authenticated 404-whitelist +
    cross-child + leak probe need TEST_PARENT_TOKEN/TEST_CHILD_IDs — no test
    credentials provisioned; mode correctly denies demo-local with 403 and
    token-less UUIDs with 401).
  - `npm run test:isolation` vs demo server (:3001, Supabase unset):
    41 passed, 0 failed, 0 skipped — including live traversal→404,
    unknown-doc/job→404, UUID-without-auth→403, and the injected
    sibling + legacy chunk leakage probe (lesson returned honest "I don't
    know"; `vectors.json` byte-restored, 0 probe residue; demo import/delete
    artifacts removed afterwards).
  - `npx tsc --noEmit` → PASS throughout.
  - `npx eslint` on every created/modified file → CLEAN. Full `npm run lint`
    still exits 1 with 66 pre-existing problems in untouched files/patterns
    (`any` types, set-state-in-effect, unescaped entities) — none authored by
    this work (verified line-by-line; only pre-existing findings remain).
  - `npm run build` → PASS (19 routes, static + dynamic as before).
  - `npm run evaluate:ask` (demo server + imported demo docs + Ollama
    gemma3:4b/nomic-embed-text): 36/36 passed — grounding behavior preserved
    under child-scoped retrieval.
- Results: all five stages complete on the current branch. No commits, pushes,
  or deploys made. No cloud sync, hosted AI, or external transmission added;
  Ollama remains the only inference path. No secrets in changed files;
  `.env.local`, `vectors.json` (5 chunks), `uploads/` (5 legacy docs) restored.
- Remaining limitations / follow-ups (not blockers):
  1. Authenticated cross-child live matrix needs provisioned test credentials.
  2. `npm run lint` baseline was already red before this work — separate cleanup.
  3. Child profile edit/delete (`PATCH/DELETE /api/children`) deferred as
     out-of-scope for the security plan.
  4. `chat/route.ts` is retrieval-free and intentionally unchanged; if it ever
     receives document context it must go through the same verifier.

---

# Audit Fixes — implementation log (approved Adversarial Security Audit)

## Stage 1 — Restore authenticated functionality (authedFetch)
- Changed files:
  - `src/lib/supabase/authedFetch.ts` (new): `getParentToken()`,
    `getAuthHeaders()`, `apiFetch(path, {method, body, form, timeoutMs})`
    injecting `Authorization: Bearer` when a session exists; no silent
    demo-local fallback (401/403 surface to callers).
  - `src/app/lesson/ClientLesson.tsx`: `generateLesson` + `generateVideo`
    via `apiFetch` (video now includes `childId` — H3 fixed); explicit
    401/403 sign-in message, no namespace fallback.
  - `src/app/quiz/page.tsx`: `generateQuiz` via `apiFetch` + 401/403 message.
  - `src/app/ask/page.tsx`: all three `/api/ask` POSTs via `apiFetch`
    (answer/explanation already surfaced `data.error`).
  - `src/app/upload/page.tsx`: documents GET, upload (multipart), confirm,
    toggle, import, delete via `apiFetch`.
- Checks: `tsc --noEmit` PASS; `eslint` on helper CLEAN (page findings
  pre-existing only).

## Audit Stage 2 — Local vs request child IDs split (H1)
- Changed files:
  - `src/lib/store/activeChild.ts`: added `resolveLocalChildId(learnerId)`
    (learner → else `demo-local`; URL hint ignored) and
    `resolveRequestChildId` (previous behavior, aliased as
    `resolveActiveChildId` for compatibility). Documented never to collapse.
  - `ClientLesson.tsx`, `quiz/page.tsx`, `ask/page.tsx`: `localChildId` used
    for every IndexedDB/sessionStorage read+write (get/getOwned/list/save/
    delete/active pointer/handoff key/history saves); request `childId` only
    in API bodies + navigation URLs. Deep links for the selected child keep
    working; mismatched ids yield the existing safe empty state.
  - `upload/page.tsx`, `page.tsx`: unchanged (API hints only, no local reads).
- Checks: `tsc --noEmit` PASS.
- Residual: URL `lessonId` values remain untrusted references; content loads
  only through ownership-checked getters.

## Audit Stage 3 — Idempotent ingestion + failure cleanup (M1, M3)
- Changed files:
  - `src/lib/ingest.ts`: `finalizeDocumentText` restructured into
    fallible-first (normalize + Ollama embeddings, zero mutation) then commit
    (file + metadata + delete-old-chunks + add-chunks). Re-ingestion replaces
    the same (document, child) chunks via child-scoped
    `deleteChunksByDocument` (no cross-namespace effect, no duplicate
    stacking). Commit failures roll back file/metadata/chunks from snapshot
    (best-effort); embedding failures leave no misleading metadata or orphans.
- Checks: `tsc --noEmit` PASS; `eslint` CLEAN.

## Audit Stage 4 — Local-only AI pin (M4)
- Inspected: `/api/chat` was the only live entry point using `aiService`,
  whose auto mode returns `GeminiProvider` on web (would send kids' prompts
  off-device once a key is set). No UI page calls `/api/chat`;
  `embeddings-web.ts` (also `aiService`-backed) has zero callers — both left
  otherwise untouched. All learning paths (lesson/quiz/ask/video) use
  `lib/ai.ts` + `lib/embeddings.ts` (Ollama HTTP only — verified).
- Changed files:
  - `src/app/api/chat/route.ts`: pinned to `new OllamaProvider()` directly;
    pre-checks `isAvailable()` and maps Ollama failures to 503 with an
    explicit on-device message. No hosted fallback, no telemetry added.
- Checks: `tsc --noEmit` PASS; `eslint` CLEAN.
- Residual: `aiService` auto→Gemini default still exists for any future
  caller — documented in code; do not route kids' data through it.

## Audit Stage 5 — Legacy title privacy in authenticated mode (M2)
- Changed files:
  - `src/app/api/documents/route.ts`: GET returns `legacy[]` only when
    `verified.mode === "demo"` (authenticated callers get `owned` only);
    POST import refuses legacy targets outside demo mode (uniform 404, no
    name oracle). Nothing is deleted; demo workflow (badge + import) intact;
    upload page hides the legacy section automatically when empty.
- Rationale: the pre-profile namespace has no owner, so titles (and import
  copies) are confined to the local/demo trust zone; an authenticated parent
  needing old material re-uploads the source file (creates an owned doc).
- Checks: `tsc --noEmit` PASS; `eslint` CLEAN.

## Audit validation (all five stages)
- `scripts/test-per-child-isolation.mjs` extended: +9 static checks (Stages
  1–5 needles) and live Stage-3 probes (idempotent re-upload chunk counts,
  empty-upload 422 with set-diff orphan check, scoped-delete cleanup).
- Demo server (Supabase unset): **53 passed, 0 failed, 0 skipped** — incl.
  traversal→404, unknown→404, UUID-no-token→403, re-upload `chunks 1 → 1`,
  empty-upload 422, sibling+legacy probe excluded. One test-authoring bug
  found and fixed during the run (owned-set comparison, not app code).
- Authenticated server (Supabase configured): **48 passed, 0 failed** —
  3 skips recorded with reason (cross-parent 404-matrix + authed leak probe
  need TEST_PARENT_TOKEN + two child IDs; not provisioned, not claimed).
- `/api/chat` pin verified live against Ollama (200, local model, 4.3s).
- `tsc --noEmit` PASS (final). `eslint` on all touched files: only
  pre-existing findings (quiz `any`s, unused imports/vars — identical to
  baseline, none authored here). `npm run build` PASS (19 routes).
- `evaluate:ask` (demo server, fixtures imported to demo-local): **36/36**.
- Cleanup verified: `vectors.json` 5 legacy chunks, `documents.json` 5 legacy
  entries, `uploads/` back to fixture set, empty `demo-local/` removed, no
  dev servers left running, no commits/pushes/deploys.
- Residual risks / decisions needed:
  - H4 (client-supplied `lessonText` unverified) explicitly UNRESOLVED —
    documented in code; needs the trusted lesson-storage design decision.
  - Authenticated cross-parent live test still unexecuted (needs 2 test
    parents; recipe in `docs/v1-security-audit-findings.md`).
  - 503-on-outage path is code-inspection only (never executed).
  - Empty child namespace dirs linger after document delete (cosmetic).
  - `aiService` auto→Gemini default remains for hypothetical future callers;
    kids' live paths are Ollama-pinned. `embeddings-web.ts` dead code kept.

## Audit validation (Stages 1–5 + Playwright)
- New/changed since the first audit round: `authedFetch.ts`,
  `resolveLocalChildId` split, idempotent `finalizeDocumentText`, Ollama-pinned
  `/api/chat`, demo-gated legacy, `LearnerContext.hydrated`, owner-keyed lesson
  load guard, topic reset on failed loads, hydration-gated quiz/ask effects.
- Playwright-found real bug (fixed, verified): learner restores AFTER the first
  render (child effects run before parent effects), so the first record-load ran
  as demo-local; the old id-only dedup guard then pinned the wrong result and a
  stale topic stayed in the input. Fixed via `hydrated` gating + `owner:id`
  guard keys + topic reset. `scripts/verify-per-child-playwright.mjs` (8 steps,
  Chromium, screenshots in `artifacts/verify/`, self-cleaning): **all steps
  passed** — home, upload, owned list, legacy badge, import, grounded lesson,
  URL-swap blocked, quiz.
- `test:isolation`: demo **53/53**, authenticated **48/48 + 3 documented skips**
  (cross-parent needs provisioned test parents — recipe in audit doc, NOT
  claimed). Chat pin verified live (Ollama 200). `tsc` PASS, touched-file
  `eslint` clean except the pre-existing set-state-in-effect pattern
  (LearnerContext mount restore — same rule as the red baseline),
  `npm run build` PASS,
  `evaluate:ask` **36/36** (demo server, fixtures imported then removed).
- Cleanup verified: 5 legacy docs/chunks only, no probe residue, no empty
  namespace dirs, no servers left running, no commits/pushes/deploys.
- Residual: H4 (unverified `lessonText`) UNRESOLVED by design constraint;
  cross-parent live test + 503 path still code-inspection only; empty
  namespace dirs linger after deletes (cosmetic).
