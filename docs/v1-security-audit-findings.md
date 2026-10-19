# Adversarial Security Audit — V1 Per-Child Isolation (no code changed)

Audited against the actual working tree (not the log): `requireChild.ts`, all API routes, `retrieval.ts`, `vectorStore.ts`, `documents.ts`, `ingest.ts`, `ocr-jobs.ts`, `lessonStorage.ts`, `store/*`, all five `resolveActiveChildId` callers, plus live-test evidence from Stage 5. Anything marked **tested** was actually run; everything else is **code inspection**.

## Critical

**None found.** No complete authentication bypass exists: every personalized route calls `verifyChildOwnership` before any read/write (`lesson:178`, `quiz:1388`, `ask:1623`, `generate-video:165`, `documents:27/46/90/131`, `upload:121`, `confirm`), retrieval filters before scoring (`retrieval.ts:114`), and live tests proved missing → 400, token-less UUID → 401/403, and sibling+legacy chunks excluded (honest "I don't know", 41/41 demo-live green, vectors restored).

## High

### H1. Local IndexedDB records enumerable via `?childId=` URL swap (tested pattern, inspection-confirmed)
- **Files:** `src/lib/store/activeChild.ts:resolveActiveChildId`, callers in `ClientLesson.tsx:164`, `quiz/page.tsx:43`, `ask/page.tsx:50`, `upload/page.tsx:47`; read path `store/lessons.ts:getLesson/listLessons` → `lessonStorage.getOwned/listFor` (same pattern in `quizzes.ts`/`ask.ts`/`progress.ts`).
- **Abuse:** with no active learner (or a signed-out browser), anyone on the device opens `/lesson?childId=<victim-UUID>&lessonId=<victim-lesson-UUID` — or just `?childId=<victim-UUID>` to list **all** of the victim's lesson titles/topics via `listLessons(childId)`, then open each. `getOwned` compares against the attacker-supplied `childId`, so the check is tautological. Victim UUIDs are exposed in browser history, the `/profile` page (parent session), and shared links. Same hole exposes quiz attempts, Ask sessions, and progress. Server-side docs/vectors are **not** affected (server re-verifies).
- **Fix (smallest):** when a learner is set, force `learner.id` and ignore the URL hint; when no learner is set, allow only `demo-local` for **local** reads (server calls may still carry the URL hint since the server verifies). I.e. split resolution into `resolveLocalChildId` (learner.id ?? demo-local) for store access and `resolveRequestChildId` (current behavior) for API bodies.

### H2. Authenticated persona broken: no session token forwarded (tested — got 401s)
- **Files:** `ClientLesson.tsx:generateLesson/generateVideo`, `quiz/page.tsx`, `ask/page.tsx` (3 POSTs), `upload/page.tsx` (upload/confirm/toggle/delete/import). Only `profile/page.tsx:47,57` sends `Authorization: Bearer`.
- **Abuse/impact:** fail-closed, so no leak — but every personalized call as a signed-in parent returns 401/403. The flagship flow (Veera → Child A/B) does not work; worse, users will be stranded in `demo-local`, mixing namespaces. This also makes the "constrained to verified profile list" claim moot until wired.
- **Fix (smallest):** one `authedFetch(path, body)` helper (reads `getSupabase().auth.getSession()` → injects `Bearer` + `childId`) used by all six call sites above. No server change needed.

### H3. `generateVideo` never sends `childId` → dead button (inspection)
- **File:** `ClientLesson.tsx:404-408` (`body: {topic, age}`) vs `generate-video/route.ts` (requires verified `childId` → 400; error swallowed by `catch { console.error }`, silent failure).
- **Fix:** include `childId` in that body (covered by the H2 helper).

### H4. Client-supplied `lessonText` bypasses lesson-grounding rules (inspection; limits verified)
- **Files:** `quiz/route.ts:1388` (`groundingSource = lessonText || context`), `ask/route.ts` lessonMode (`context = lessonText`, retrieval skipped). Client checks (`getLesson` ownership) do not constitute server authorization.
- **Abuse:** anyone who can call the API (same device, or any authenticated caller) anchors a quiz/Ask on **arbitrary invented text**, defeating "quiz ONLY facts the child already read" and Ask's `questionCoveredByLesson` gate (coverage against attacker text passes trivially). Data-exfiltration scope is bounded (attacker needs the text to send it), but grounding integrity is fully bypassable.
- **Fix (smallest, no architecture change):** client sends `lessonId` instead of raw text; server keeps an allow-list in-memory? Not verifiable server-side for IndexedDB lessons. Honest options: (a) accept residual risk on the single-family device trust boundary and label `lessonText` untrusted (current state, documented in code); (b) real fix = server-persisted lesson registry, which is an architectural change — **stopping here per instructions; needs your decision before building.**

## Medium

### M1. Re-upload/import duplicates embedding chunks (inspection)
- **Files:** `ingest.ts:finalizeDocumentText` → `addChunks` (pure append); `documents/route.ts:POST import`.
- **Abuse/integrity:** importing the same legacy doc twice (or re-uploading a filename) stacks duplicate vectors, skewing retrieval scores toward that text. Not a leak.
- **Fix:** `deleteChunksByDocument(relName, childId)` immediately before `addChunks` in `finalizeDocumentText` (upsert semantics; already child-scoped).

### M2. Legacy document *titles* visible to any same-device account (inspection)
- **File:** `documents/route.ts:GET` returns `legacy[]` (names) to every verified child, including an authenticated parent from a different family on a shared computer. Content stays protected (import copies per child), but titles like `IEP-Plan.txt` can be sensitive.
- **Fix (smallest, preserves function):** return `legacy[]` only in demo mode; for authenticated mode, tag newly staged legacy at read time going forward and hide untagged legacy behind an explicit "show pre-profile documents" toggle. Alternatively accept and document — your call.

### M3. Orphaned doc on embed failure (inspection)
- **File:** `ingest.ts` — file + metadata persist before `createEmbedding`; if Ollama is down mid-upload, a metadata entry exists with zero chunks (silent retrieval miss).
- **Fix:** order as file → embed → metadata+chunks commit; on embed throw, remove the staged file. Small `try/catch` in `finalizeDocumentText`.

### M4. `/api/chat` can leave the device via hosted provider (pre-existing, verified in code)
- **Files:** `chat/route.ts` → `services/aiService.ts:41` (auto mode defaults to `GeminiProvider`); `GEMINI_API_KEY` is currently empty in `.env.local` so it fails closed today. All lesson/quiz/ask/video paths use `lib/ai.ts` (Ollama-only — confirmed, only `/api/generate`+`/api/embeddings` fetches). I did not introduce this; flagging because "Ollama-only" is otherwise true for every path I touched.
- **Fix:** pin `AI_ENGINE=ollama` for the chat route or remove the hosted fallback from the kids' path. Needs your decision (touches AI-runtime config).

## Low

- **L1. Pre-binding OCR jobs are demo-only** (`confirm/route.ts`): safe direction (deny), but a parent who uploaded just before this release must re-upload. Documented; acceptable.
- **L2. `documents PATCH` response shape changed** (full list → owned-only): the only caller re-fetches, verified. No action.
- **L3. Probe constants + `childId.slice(0,8)` log truncation** — safe (verified non-empty before slice). No action.
- **L4. Full-repo `npm run lint` red (66 pre-existing issues)** — untouched files only; my files are clean. Separate cleanup, not security.

## Tested vs inspected (honesty ledger)

- **Ran live:** missing/invalid `childId` → 400 (8 routes); demo-mode matrix incl. traversal→404, unknown→404, UUID-no-token→403; authenticated-mode deny matrix (demo→403, UUID-no-token→401); sibling+legacy injection probe → honest unknown; Ask eval 36/36; build PASS; `tsc` PASS.
- **Inspection only:** 503-on-outage path (injected overrides exist but were never executed — recommend a unit run with `ownsChild` throwing before claiming it); cross-parent (below); H1/H4 abuse flows (written from code, not executed against a victim).

## How to run the skipped cross-parent tests

No code changes needed — provision two test parents (one-time, ~5 min):

```bash
# 1. Start the configured dev server (:3000) and create two parents via /auth
#    in two browser profiles (or via supabase-js signUp). Save TOK_A, TOK_B.
# 2. Create one child per parent, save UUID_A (child of A) and UUID_B:
curl -s -X POST localhost:3000/api/children \
  -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' \
  -d '{"nickname":"A1","age":6}'            # -> {"child": {"id": "UUID_A", ...}}
curl -s -X POST localhost:3000/api/children \
  -H "Authorization: Bearer $TOK_B" -H 'Content-Type: application/json' \
  -d '{"nickname":"B1","age":12}'           # -> UUID_B
# 3. Cross-parent assertions (expect 403/404, never 200 or data):
curl -s -o /dev/null -w "A-reads-B-docs: %{http_code} (want 404)\n" \
  -H "Authorization: Bearer $TOK_A" "localhost:3000/api/documents?childId=UUID_B"
curl -s -o /dev/null -w "A-lessons-on-B: %{http_code} (want 403)\n" \
  -X POST localhost:3000/api/lesson -H "Authorization: Bearer $TOK_A" \
  -H 'Content-Type: application/json' -d '{"topic":"Elephants","childId":"UUID_B"}'
curl -s -o /dev/null -w "A-asks-on-B: %{http_code} (want 403)\n" \
  -X POST localhost:3000/api/ask -H "Authorization: Bearer $TOK_A" \
  -H 'Content-Type: application/json' -d '{"question":"What?","mode":"question","childId":"UUID_B"}'
curl -s -o /dev/null -w "A-deletes-B-doc: %{http_code} (want 404)\n" \
  -X DELETE localhost:3000/api/documents -H "Authorization: Bearer $TOK_A" \
  -H 'Content-Type: application/json' -d '{"name":"<B-doc>","childId":"UUID_B"}'
# 4. Then delete both test parents (Supabase dashboard) to clean up.
```

If you give the go-ahead, I recommend implementing in this order: **H2+H3** (one helper, restores the authenticated flow), **H1** (local-resolution split), **M1+M3** (ingest robustness), then your decision on **H4** (accept residual vs server registry) and **M4** (chat provider pin).
