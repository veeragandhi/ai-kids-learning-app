# RAG Skill

Use this skill when working on AmigosNest retrieval (`lib/retrieval.ts`,
`lib/embeddings.ts`, `lib/chunk.ts`, `lib/vectorStore.ts`, `lib/ingest.ts`).

Current implementation: query → `nomic-embed-text` embedding via Ollama →
cosine + lexical hybrid (`0.7 * cosine + 0.3 * lexical`), keep `cosine >= 0.50`
AND `lexical > 0`, top 3, then `contextSupportsQuery` support check. See
`.agents/skills/ask/SKILL.md` for the Ask-side contract.

Principles:

- Retrieval quality beats larger prompts.
- Smaller relevant context beats larger context.
- Avoid duplicate chunks.
- Prefer semantic search + lexical support check.
- Keep chunk size consistent (500 words / 100 overlap in `chunkText`).
- High cosine similarity is NOT factual relevance — verify the chunk text.
- If no chunk clears the threshold, return "" and let the route abstain.
- Never compensate for irrelevant context by complicating the prompt.
- Keep Ollama. Never swap in a cloud embedding/LLM provider.

Troubleshooting order (matches your AmigosNest agent instructions):

1. Retrieved chunks (what + scores in `[retrieval]` logs)
2. Retrieval relevance (lexical overlap? wrong doc?)
3. Source grounding (does `uploads/*.txt` even contain the fact?)
4. Was required info actually extracted (text layer vs image/table?)
5. Image/table carrying the missing info (OCR gap, not retrieval gap)
6. Chunking
7. Embeddings
8. Similarity search / thresholds
9. Prompting
10. Model selection (last resort)

Metrics:

- Retrieval relevance
- Answer accuracy
- Response latency
- Abstention correctness (says "I don't know" exactly when context is missing)