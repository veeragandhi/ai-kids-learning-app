# Educational AI Skill

Use this skill when changing child-facing learning behavior in AmigosNest:
`app/api/lesson/route.ts`, `app/api/quiz/route.ts`, `app/api/ask/route.ts`,
and their pages (`app/lesson/`, `app/quiz/`, `app/ask/`).

Product idea: help kids reason, explain, and discover answers instead of
simply giving them answers. Primary audience is children ~4-10 with
parents controlling the material. Keep UX calm, safe, friendly, encouraging.

Current implementation anchors (inspect before changing):

- Lesson: `buildLessonPrompt` + `toTeachingText(context)` (strips worksheet
  scaffolding, falls back to raw context) + `cleanLessonText` safety net.
  Age bands: <=6 (80 words, 5-8 word sentences), <=9 (120 words, ~12-word
  sentences), 10+ (160 words, ~15-word sentences + one why/how detail).
  Grounded in `getRelevantContext(topic)`; no context → exact
  `I don't know. Please ask a parent to add more information.`
- Quiz: questions derived from retrieved material only; must have a valid
  answer, match level, avoid ambiguity; never fabricate confidence.
- Ask: Socratic guided flow — see `.agents/skills/ask/SKILL.md`. Guide with
  concept-specific clues, never generic `What do you think?`, never mark
  wrong answers correct, admit uncertainty when evidence is missing.

Answers should:

- teach
- explain
- guide (specific clues, e.g. `If plants need sunlight to make food, what
  might happen in a dark cupboard?` — not generic templates)
- use age-appropriate words (see age bands above)
- stay grounded in retrieved context; say `I don't know` when it is missing

Avoid:

- overly academic language
- unnecessary jargon
- information overload
- giving away the final answer when guided reasoning is appropriate
- inventing facts to make a lesson richer
- copying worksheet scaffolding (question numbers, Tick/Match/Fill/Circle,
  `(a / b)` options, `[BLANK]`, `[ ]`, `<br>`) into lessons
- asking quiz questions inside a lesson (that is the Ask flow's job)

Prefer:

- examples
- analogies
- step-by-step explanations
- practical demonstrations

Goal:

Help users learn concepts, not merely receive answers — demonstrated by a
parent uploading real material, the child learning from it, asking
questions, and getting grounded guidance without hallucination.