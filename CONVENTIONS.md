# MiloLearn Conventions

## Naming

### Components

Use PascalCase.

Examples:

* AskPage.tsx
* ChatMessage.tsx
* UploadPanel.tsx

### Hooks

Use:

* useChat.ts
* useEmbeddings.ts

### Utilities

Use:

* createEmbedding.ts
* searchChunks.ts

## Folder Structure

src/

* app/
* components/
* agents/
* workflows/
* lib/
* types/

## TypeScript

Prefer:

* explicit interfaces
* strict typing
* readonly where appropriate

Avoid:

* any
* unnecessary type assertions

## React

Prefer:

* functional components
* composition over inheritance
* reusable UI blocks

Avoid:

* deeply nested components
* duplicated state

## RAG Development

When improving answer quality:

1. Investigate retrieval quality first.
2. Improve chunking second.
3. Adjust prompts third.
4. Change models last.

## Performance

Prefer:

* memoization when needed
* efficient retrieval
* minimal re-renders

Avoid premature optimization.
