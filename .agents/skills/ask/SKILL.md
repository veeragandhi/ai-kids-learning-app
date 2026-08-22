---
name: ask
description: "Use when modifying, debugging, reviewing, or testing the AmigosNest Ask learning flow and its API at app/api/ask/route.ts, including retrieval, Socratic modes, hints, JSON fallbacks, and child-facing behavior."
argument-hint: "Describe the Ask learning behavior you want to change or evaluate"
---

# Ask Skill

Use this skill for safe changes to the AmigosNest Ask learning flow and `POST /api/ask`. The endpoint and its client form a child-facing, retrieval-grounded Socratic workflow. Preserve the learning contract while improving retrieval, prompts, parsing, hints, or response quality.

## Scope And Anchors

Primary implementation:

- `app/api/ask/route.ts` owns request validation, context lookup, prompt selection, model invocation, response normalization, and fallbacks.
- `lib/retrieval.ts` creates the query embedding, scores stored chunks, applies `minSimilarity = 0.50`, and returns up to three chunks.
- `lib/ai.ts` calls the local Ollama `gemma3:1b` model with low temperature and a bounded prediction length.
- `app/ask/page.tsx` is the client contract and demonstrates the three-call conversation.

Before editing, identify which of these boundaries controls the behavior. Retrieval problems should be investigated in chunking, embeddings, and similarity before changing prompt wording or model settings.

## Request And Response Flow

1. Parse JSON and apply defaults: `age` defaults to `8`, `mode` to `question`, and `questionType` to `guided`.
2. Trim text inputs. Require `question` for `question` mode, `studentAnswer` for `answer` mode, and `explanation` for `explanation` mode. Return HTTP 400 with an `error` message when the mode-specific input is missing.
3. Retrieve context using the first available text: `question`, then `studentAnswer`, then `explanation`.
4. If no context clears the retrieval threshold, return HTTP 200 with the honest no-context message: `I don't know. Please ask a parent to add more information.` Do not call the LLM in this case.
5. Build the prompt for the selected mode and call Ollama. Return HTTP 500 with `Failed to generate a response.` when the model call fails.
6. Parse model output as JSON, tolerating code fences, curly quotes, trailing commas, and a small set of known misspellings. If parsing fails, return a safe mode-specific fallback rather than exposing raw model output.
7. Validate child-facing text, normalize the response type, reject a guiding question that repeats or effectively answers the original question, and attach `source: "Document"` plus internal timing data.

Treat timing fields and logs as diagnostics, not as user-facing content or a stable client contract.

## Retrieval Pipeline

The endpoint retrieves before prompting:

1. Embed the selected query with the configured embedding provider.
2. Load chunks from the local vector store.
3. Compute cosine similarity and sort descending.
4. Keep only chunks at or above `0.50`, then keep the top three.
5. Join selected chunk text with newlines and place it in the prompt.

When evaluating retrieval, inspect the selected documents, scores, duplicate chunks, empty stores, embedding dimension errors, and latency. Prefer smaller relevant context over adding more context. Never compensate for irrelevant context by making the prompt more complicated. Keep the `Use ONLY the context` boundary intact.

## Prompt Construction

Prompts must remain explicit about:

- the child's age;
- using only retrieved context;
- simple, clear English;
- not inventing facts;
- the exact JSON schema expected from the model;
- the required next step for the current mode.

Keep user-provided question, answer, and explanation clearly delimited from instructions. If changing prompt text, check that interpolation cannot accidentally remove the context boundary or the JSON schema. Keep model output short enough for the endpoint's `numPredict: 60` budget unless the budget is deliberately changed and evaluated.

## Three Ask Modes

### `question`

Input: `question`, optional `age`, and `questionType` (`guided` or `creative`). Output: `type: "guidingQuestion"`, a short `question`, `hintLevel`, and `questionType`. It must guide noticing, comparing, or finding a clue without stating the answer, repeating the original question, or asking yes/no.

Creative mode asks the child to invent an example using the retrieved context. Guided mode helps the child think without answering directly.

## Hint Ladder And Learning State

The intended learning progression is explicit and should not be replaced with an unsolicited direct answer:

1. Nudge: invite the child to notice a clue.
2. Strategy: suggest how to search, compare, or connect evidence.
3. Partial worked example: demonstrate part of the reasoning without completing the answer.
4. Answer: reveal the answer only after the child explicitly escalates for it.

When implementing escalation, keep hint state attached to the question or learning session, record `hintLevelReached`, and make the current hint level visible to the workflow. Do not silently jump from a child's uncertainty to an answer. A request such as “just tell me” should receive an easier guiding question unless the product explicitly defines it as an escalation.

### `answer`

Input: original `question`, `guidingQuestion`, and `studentAnswer`. Output: `type: "evaluation"`, `correctness`, kind `feedback`, exact `nextPrompt: "How did you know?"`, and `hintLevel`. Evaluation must be based only on retrieved context and distinguish correct, partially correct, and incorrect answers.

### `explanation`

Input: original `question`, `guidingQuestion`, `studentAnswer`, and `explanation`. Output: `type: "explanationFeedback"`, a `0`-to-`100` `score`, evidence-based `feedback`, and `finalPrompt`. Score the child's reasoning and use of evidence, not guessed correctness when the explanation is unclear.

## Socratic And Age 7-12 Principles

- Lead with a manageable clue, observation, comparison, or connection instead of immediately giving the answer.
- Use warm, concrete, short sentences and familiar words.
- Preserve productive thinking: feedback should name what is useful and invite one evidence-based next step.
- Never shame uncertainty. A child saying they do not know should receive a simpler prompt or hint.
- Avoid yes/no questions, long explanations, unsupported facts, sarcasm, and adult academic jargon.
- Keep the experience suitable for ages 7-12. Do not assume advanced vocabulary, background knowledge, or sustained attention.
- Age changes the language and difficulty, but not the grounding and safety invariants.

## Product Invariants

The primary product invariant is:

> **AmigosNest should help the child think rather than immediately give the answer.**

Every change must preserve the following invariants unless the product contract is intentionally changed and all callers are updated:

### Learning behavior

- **No direct answer leakage:** `question` mode guides the child toward evidence and does not reveal the answer. An answer is only appropriate after the product's explicit hint escalation path.
- **Age-appropriate language:** child-facing text is short, concrete, kind, and suitable for ages 7-12. It avoids unnecessary difficulty, jargon, shame, and overwhelming explanations.
- **Useful, non-repetitive questions:** guiding questions must add a useful next thinking step, not repeat the original question, paraphrase it without progress, or ask an unhelpful yes/no question.
- **Relevant questions:** a guiding question must relate to the child's question and retrieved material. It should prompt noticing, comparing, connecting, or finding evidence.
- **Supported claims only:** feedback and explanations may affirm or discuss claims supported by retrieved context, not unsupported model knowledge or praise for invented facts.
- **Honest uncertainty:** when retrieval does not contain the answer, the system must say that information is unavailable or ask for more material. It must not hallucinate an answer.
- **Correct-answer recognition:** `answer` mode must recognize a correct answer even when it is brief, uses child-friendly wording, or includes extra relevant detail.
- **Appropriate feedback:** incorrect, partial, uncertain, irrelevant, and correct answers receive distinct, kind, actionable feedback. Feedback should invite evidence and never shame the child or accidentally disclose an answer.

### API and flow behavior

- Answers and questions are grounded only in retrieved document context.
- Missing context produces an honest no-context response, never a fabricated answer.
- Missing mode-specific input is a 400 response.
- LLM failure is a 500 response with a safe generic error.
- Malformed or hostile model formatting cannot crash the route or leak raw output to the child.
- The three response types remain stable: `guidingQuestion`, `evaluation`, and `explanationFeedback`.
- The transitions between `question`, `answer`, and `explanation` remain intact, with compatible request fields and response fields at every step.
- Guiding questions do not repeat the original question or directly reveal its answer.
- `answer` always asks `How did you know?` as its next prompt.
- Every answer, right or wrong, leads to an explanation step that asks how the child knows; explanation quality is evaluated with a rubric, not string matching.
- Hint escalation is explicit and the reached level is recorded when hint state is implemented.
- Creative mode remains open-ended and can ask the child to invent their own example from the context.
- Child-facing text does not expose diagnostic timing or raw model output.
- Client payloads in `app/ask/page.tsx` remain compatible with the endpoint.

### Required review gate

When reviewing or modifying Ask behavior, explicitly check each of these questions:

1. Did the change cause direct answer leakage?
2. Did it make language unnecessarily difficult for the target age?
3. Did it create repetitive or irrelevant questions?
4. Did it allow unsupported claims or hallucinations when retrieval lacks the answer?
5. Can it still recognize correct, partial, incorrect, irrelevant, very short, and detailed answers appropriately?
6. Is the feedback kind, useful, and evidence-focused?
7. Do all `question` → `answer` → `explanation` transitions still work with their required schemas?

A change is not complete until the affected questions are answered with scenario tests or a documented reason why a check is not applicable.

## Known Failure Modes

Check these before attributing a regression to the model:

- Empty or stale vector data causes the no-context response.
- Low similarity or poor chunking yields irrelevant context.
- Query embedding and stored embeddings have different dimensions.
- Ollama is unavailable, the model is missing, or the model returns no response.
- Ollama emits markdown fences, curly quotes, trailing commas, misspelled keys, extra prose, or invalid JSON.
- A guiding question is too similar to the original question, is not English, or is effectively a yes/no question.
- Parsed fields have the wrong type, are empty, or exceed the intended child-friendly shape.
- A malformed request body can fail before mode validation; changes to request parsing should make malformed JSON an intentional, tested error path.
- Retrieval is performed for the selected text, so answer/explanation follow-ups depend on the original question being included by the caller.
- A verbose or overly enthusiastic fallback can accidentally reveal the answer, praise unsupported facts, or make the child-facing flow inconsistent with the Socratic plan.
- The model may return another language or a yes/no question even when prompted otherwise; language, brevity, and question shape need deterministic validation or a safe fallback.

When debugging, capture the request mode, retrieval count and scores, prompt schema, model availability, parse result, and final normalized response. Do not log sensitive child content more broadly than the existing local diagnostics require.

## Safe Modification Procedure

1. State the behavior change and the invariant it must preserve.
2. Reproduce with one request for the affected mode and one nearby boundary case.
3. Trace the smallest owning boundary: route validation, retrieval, prompt construction, parsing, normalization, or client contract.
4. Make the smallest change. Avoid changing retrieval thresholds, model choice, and prompt rules in the same experiment.
5. Re-run the focused check before broad validation. Compare both HTTP status and response shape, not only whether text exists.
6. Test malformed model output and no-context behavior when touching parsing or prompts.
7. For learning-flow changes, test the full sequence: question → guiding question → answer evaluation → explanation rubric.
8. Run lint and build before considering the change complete.

## Testing Procedure

Prerequisites for behavioral checks:

- dependencies installed with `npm install`;
- the local vector store contains the intended document chunks;
- Ollama is running at `http://localhost:11434` with `gemma3:1b` available.

Run static validation:

```powershell
npm run lint
npm run build
npm run evaluate:ask
```

The dependency-free harness uses [scenario data](./evaluations/scenarios.json) and [the evaluator](./scripts/evaluate-ask.mjs). It sends live requests to `/api/ask`, applies semantic checks, and exits nonzero when a scenario fails. It does not require or assert one fixed model sentence. Use `--scenario <id>` for a focused check, `--base-url <url>` for another server, `--json` for machine-readable output, or `--fail-fast` to stop after the first failure. The endpoint must be running with the uploaded sample documents and Ollama available.

The 22 scenarios cover correct, incorrect, partial, uncertain, direct-request, irrelevant, repeated, short, and detailed child answers; present, absent, irrelevant, and multi-chunk context; ages 7, 9, and 12; creative questions; and explanation scoring. The evaluator checks response schemas, correctness labels, grounding signals, age-oriented length, Socratic question shape, answer leakage, and useful follow-up structure. Since the endpoint does not expose retrieved chunks, context checks are black-box checks based on expected evidence and uncertainty; do not claim they directly prove which chunks were selected.

Exercise additional endpoint boundaries with a local request tool or the Ask page. Cover at least:

1. Valid `question` guided mode: 200, guiding-question schema, grounded short question.
2. Valid `question` creative mode: 200, creative question behavior.
3. Valid `answer` mode: 200, evaluation schema, `How did you know?`.
4. Valid `explanation` mode: 200, numeric 0-100 score and final prompt.
5. Missing question, answer, and explanation: each mode returns 400.
6. Irrelevant or empty retrieval: 200 honest no-context response and no LLM dependency.
7. Ollama unavailable: 500 safe error.
8. Malformed, fenced, or extra-prose model JSON: normalized safe response or mode fallback.
9. A generated guiding question that repeats the original: default clue question.

For each case verify grounding, age-appropriate language, response type, required fields, and that raw model output or `_timing` is not presented as child-facing content. Record retrieval relevance, answer accuracy, and response latency for quality comparisons.

## Definition Of Done

An Ask API change is done when:

- the requested behavior works in the affected mode and its neighboring mode boundaries;
- all product invariants remain true;
- no-context, validation, LLM, malformed-JSON, and duplicate-question paths were considered and tested when relevant;
- retrieval quality was checked before prompt or model changes for grounding issues;
- `npm run lint` passes;
- `npm run build` passes;
- client payload and response handling remain compatible;
- the skill or related documentation is updated if the contract, workflow, or known failure modes changed.