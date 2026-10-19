# AmigosNest V1 — Per-Child Isolation + Security Fix Plan

> Status: approved plan, not yet implemented.
> Source: security review + agreed decisions (subdir namespacing, fail-closed
> `childId`, demo/auth separation, node-script tests only).

## 0. Locked decisions

- Family identity: `parent_id = auth.users.id` is the family id for V1.
  No `families` table. Profiles stay pseudonymous (nickname, avatar, age 3–18,
  learning preferences). No date of birth.
- Files: `uploads/<childId>/<basename>.txt`. Legacy top-level files stay
  read-only with a “Created before profiles” badge + explicit import.
- Missing `childId` on personalized calls: fail closed with `400 Bad Request`.
  Never fall back to “all documents.” Client shows “select a child.”
- Demo/auth boundary: unauthenticated allows only `demo-local`; authenticated
  rejects `demo-local`. A real child UUID request is never downgraded to
  unauthenticated access.
- Tests: dependency-free `scripts/test-per-child-isolation.mjs` only.
- Non-goals for this iteration: no cloud sync, no remote document storage,
  no hosted LLM runtime change. Ollama stays the inference path. No kids
  learning data leaves the device. Existing OCR, `[BLANK]`, retrieval
  grounding, and evaluation constraints in `AGENTS.md` are preserved.

## 1. Trust boundary

New `src/lib/supabase/requireChild.ts` — `verifyChildOwnership(req, childId)`:

- Missing/malformed `childId` (not `demo-local`, not a UUID) → `400`.
- Supabase not configured or offline: allow `demo-local` only; any UUID →
  `403 sign-in required`.
- Supabase configured + UUID `childId`: require `Authorization: Bearer`,
  `getSupabaseServer(token).auth.getUser()`, then a `children` lookup on
  `id + parent_id = user.id`. No/invalid token → `401`. Owned by another
  parent → `403`. Supabase unreachable → `503` for UUID paths while
  `demo-local` still works.
- Authenticated + `childId === "demo-local"` → `403 select your child's profile`.
- Parent identity is always derived from the session, never from a
  client-supplied `parentId`. A stored `childId` alone is never authorization.
- Demo mode: the local device is the trust boundary. `demo-local` gives
  per-profile separation on one family device, not strong multi-user
  isolation against devtools or LAN peers. Keep the dev server on localhost.

All document/upload/confirm/lesson/quiz/ask handlers call this verifier first,
and the frontend sends the session token (`getSession()` → `Bearer`) with `childId`.

## 2. Stage 1 — Trust boundary (implement first)

- Create `src/lib/supabase/requireChild.ts` with the behavior above + header docs.
- No caller changes yet.
- Acceptance: owner pass; cross-parent 403; no-token + UUID 403; no-token +
  demo pass; authed + demo 403; malformed 400; outage + UUID 503.
- Stop and ask before any change needing cloud sync, hosted AI, or redesign.

## 3. Stage 2 — Retrieval isolation first

- `src/lib/retrieval.ts`: `getRelevantContext(query, topK, minSimilarity,
  { childId })` filters `getChunks()` to `chunk.childId === verifiedChildId`
  before scoring and before anything enters an LLM prompt. Legacy
  (`childId: null`) is excluded unless explicitly imported. Missing/invalid
  ownership returns `""` (honest “I don't know”).
- `src/app/api/lesson/route.ts`, `src/app/api/quiz/route.ts`,
  `src/app/api/ask/route.ts`: require the verified `childId` and forward it.
  Lesson-linked Ask verifies the displayed lesson belongs to the child before
  using `lessonText`.
- Keep cosine/lexical weights, thresholds, and prompts unchanged.
- Acceptance: Child A query contains zero Child B chunk text in logs;
  missing `childId` → `400`, never full-store results.

## 4. Stage 3 — Documents and uploads

- `src/lib/documents.ts`: add `childId` / `legacy` to metadata + add the missing
  `basename + resolve-inside-uploadDir` read guard (match `api/documents` DELETE).
- `src/lib/vectorStore.ts`: `VectorDocumentChunk { +childId }`.
- `src/lib/ingest.ts`: `finalizeDocumentText(name, text, source, { childId })`.
- `src/lib/ocr-jobs.ts`: `OcrJob { +childId }`, bound at creation, checked at confirm.
- `src/app/api/documents/route.ts`: `GET ?childId=` returns `{ owned[], legacy[] }`;
  mutations on legacy → `403` except explicit `POST /api/documents/import`
  (copy + re-chunk/re-embed under the child's id).
- `src/app/api/upload/route.ts` / `src/app/api/upload/confirm/route.ts`: verify
  `childId`, write to `uploads/<childId>/`, reject job/child mismatches.
- Keep existing whitelist + `basename` + `resolve` traversal protections.
- Acceptance: cross-child list/edit/delete/import/confirm → `403` with data
  untouched; `../../.env`-style names → `400/404`; identical basenames under
  Child A and Child B coexist.

## 5. Stage 4 — Lessons and learning history

- `src/lib/lessonStorage.ts`: add `childId`, migrate DB v1 → v2 (old records
  become `childId: null` legacy read-only).
- New lightweight `src/lib/store/` wrappers for lessons, quizzes, Ask/Explore
  sessions, and progress reusing existing storage code. `getLesson(id,
  activeChildId)` returns `null` on mismatch. Legacy records render read-only
  and never ground quiz/Ask until imported/assigned.
- Update `ClientLesson`, `quiz/page.tsx`, `ask/page.tsx`, `upload/page.tsx`,
  `profile/page.tsx`, `Navbar` to use the active (verified or demo) `childId`.
  Sibling `?lessonId=` → “not found for this child.”
- Treat client-supplied `lessonText`, `lessonTopic`, `documentId`, `jobId`,
  and `childId` as untrusted everywhere.

## 6. Stage 5 — Regression tests

- Create `scripts/test-per-child-isolation.mjs` + `npm run test:isolation` covering:
  cross-child document access, retrieval leakage, lesson-ID swapping, OCR
  job ownership mismatch, filename collisions, path traversal, missing/invalid
  child IDs, Supabase-unavailable behavior, and demo vs authenticated boundaries.
- Then `npm run lint`, `npm run build`, and `npm run evaluate:ask` when the dev
  server + Ollama + sample data are available; otherwise report exactly what
  could not be run.
- Report changed files, migration impact, test results, and residual limits
  after each stage.

## 7. Residual limitations

- Client-side IndexedDB checks are bypassable via devtools; the server-side
  retrieval and document gates are the real enforcement.
- A LAN-exposed dev server exposes the demo namespace; V1 assumes localhost.
- No new abstraction or broad migration beyond what the stages above require.
