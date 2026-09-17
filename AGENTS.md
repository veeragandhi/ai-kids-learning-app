# AmigosNest

AmigosNest is an AI-powered learning platform built using Retrieval Augmented Generation (RAG).
Earlier project name: MiloLearn. Current product name: AmigosNest.

> Help kids reason, explain, and discover answers instead of simply giving them answers.

Read `.agents/skills/ask/SKILL.md` before making substantial Ask changes.
Read `lib/ocr.ts`, `lib/retrieval.ts`, `lib/ai.ts` before touching ingestion/retrieval/generation.

## Tech Stack

* Next.js (Turbopack) + React + TypeScript (strict)
* Tailwind CSS
* Ollama (local inference) — `gemma3:1b` generation, `nomic-embed-text` embeddings, `gemma3:4b` selective vision fallback
* Local vector store (`embeddings/vectors.json`)
* pdf2json for text layer, Tesseract fast-pass OCR, pdf-image JPEG extraction (no pdf-parse — DOMMatrix issues)

## Hard Constraints (do not violate without explicit owner approval)

* Use Ollama for AmigosNest runtime AI. Do NOT replace with OpenRouter/OpenAI/cloud LLMs.
* Preserve `[BLANK]` (ASCII, searchable) for fill-in blanks through OCR → normalize → chunk → embed → retrieve → generate. Never emit `□`.
* Do NOT treat OCR/vision output as ground truth. A PDF with extracted text does NOT mean images/tables/diagrams were extracted.
* Ask/lesson/quiz must be grounded in retrieved context. Prefer `I don't know / I couldn't find that in your learning material.` over hallucination.
* Keep local-first: no kids data leaves the device, no cloud keys in runtime path.
* Do NOT introduce GraphRAG, Kernel Memory, new vector DBs, or complex orchestration without measured evidence the current architecture needs it.

## Architecture

### Ingestion Pipeline

1. Documents are uploaded (`app/api/upload/route.ts`).
2. Good text layer → `finalizeDocumentText()` in `lib/ingest.ts` (save txt → chunk → embed → store). Scanned PDF → OCR review job (`lib/ocr-jobs.ts`, `uploads/.pending-ocr/`), parent previews at `/upload`, then `POST /api/upload/confirm` embeds.
3. OCR order: PDF text extraction → quality check (`isGoodTextLayer`) → Tesseract fast-pass → confidence/structure check (`isGoodTesseractResult`: conf ≥ 75 + worksheet signals ≥ 2) → selective vision fallback only for failed pages.
4. Chunks are stored in the vector store.

### Retrieval Pipeline

1. User submits a question.
2. Query embedding is generated (`nomic-embed-text`).
3. Similar chunks are retrieved (`lib/retrieval.ts`: hybrid 0.7 cosine + 0.3 lexical, `cosine >= 0.50`, `lexical > 0`, top 3).
4. Context is sent to the LLM with `OCR_MARKER_GUARD` + `Use ONLY the context` boundary.
5. Final answer is generated, then JSON-parsed, schema-validated, and normalized.

## Before Coding

1. Inspect the existing implementation (`app/api/*/route.ts`, `lib/*`).
2. Understand the current data/API flow; reuse existing utilities before creating files.
3. Identify regression risks + behavior that must not regress.
4. Define acceptance criteria.
5. Make the smallest reasonable change, then implement → test → inspect failure → fix root cause → rerun.

## Ask Debugging (in this order — not every failure is a prompt problem)

1. Retrieved chunks + scores (see `[retrieval]` logs)
2. Retrieval relevance (is cosine high but factually irrelevant?)
3. Source grounding (does context actually contain the answer?)
4. Whether required info was ever extracted (check `uploads/*.txt` + staged OCR text)
5. Whether an image/table holds the missing info
6. Model behavior (JSON parse fallback? `num_predict` budget?)
7. Response schema (`normalizeResponseType` — reject values like `comparison`)

## OCR Rules

* Preserve question numbers, sections, page info, `[BLANK]`, table structure (markdown pipe table), image notes (`[Image: ...]`).
* `normalizeWorksheetText()` canonicalizes `_____ / … / ...` → `[BLANK]`; `toTeachingText()` strips exercise scaffolding for lessons.
* Tables must stay machine-readable; never flatten to ambiguous word soup when rows/cols matter.
* Uncertain OCR → `needsReview: true` (202) + `ocr-tesseract` / `ocr-vision — verify` label; never auto-embed unreviewed OCR.
* Vision is selective (CPU ~219s/page on i7-7600U). Never vision-every-page by default.

## AI Development Rules

* Prefer simple solutions. Avoid unnecessary abstractions.
* Reuse existing utilities before creating new files.
* Maintain TypeScript strict mode compatibility.
* Keep components small and reusable.
* Do not introduce dependencies without justification.
* Prefer deterministic validation around LLM output; log retrieval scores for debugging.
* Keep model output short enough for the endpoint budget unless deliberately changed + evaluated.

## RAG Rules

* Answers should be grounded in retrieved context.
* Never fabricate facts when context is missing.
* If information is unavailable, state that clearly.
* Retrieval quality is more important than prompt complexity.
* High cosine similarity ≠ factual relevance — apply lexical/support checks (`contextSupportsQuery`).

## UI Rules

* Maintain responsive layouts.
* Prefer accessibility-compliant components.
* Keep loading and error states visible (lesson LLM can take 10–40s on CPU — keep progress text).
* Avoid excessive animations.

## Testing

Before considering a task complete:

* npm run lint
* npm run build
* npm run evaluate:ask (for Ask changes — 22 scenarios, needs dev server + Ollama + sample docs)
* Fresh clone: `npm run seed:samples` then `node scripts/reindex-uploads.mjs` — `uploads/` and `embeddings/vectors.json` are git-ignored (local-only data), fixtures live in `.agents/skills/ask/fixtures/`

All changes should compile successfully.
