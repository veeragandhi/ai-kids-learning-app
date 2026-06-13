# MiloLearn

MiloLearn is an AI-powered learning platform built using Retrieval Augmented Generation (RAG).

## Tech Stack

* Next.js
* React
* TypeScript
* Ollama
* Nomic Embeddings
* Local Vector Store

## Architecture

### Ingestion Pipeline

1. Documents are uploaded.
2. Documents are chunked.
3. Embeddings are generated.
4. Chunks are stored in the vector store.

### Retrieval Pipeline

1. User submits a question.
2. Query embedding is generated.
3. Similar chunks are retrieved.
4. Context is sent to the LLM.
5. Final answer is generated.

## AI Development Rules

* Prefer simple solutions.
* Avoid unnecessary abstractions.
* Reuse existing utilities before creating new files.
* Maintain TypeScript strict mode compatibility.
* Keep components small and reusable.
* Do not introduce dependencies without justification.

## RAG Rules

* Answers should be grounded in retrieved context.
* Never fabricate facts when context is missing.
* If information is unavailable, state that clearly.
* Retrieval quality is more important than prompt complexity.

## UI Rules

* Maintain responsive layouts.
* Prefer accessibility-compliant components.
* Keep loading and error states visible.
* Avoid excessive animations.

## Testing

Before considering a task complete:

* npm run lint
* npm run build

All changes should compile successfully.
