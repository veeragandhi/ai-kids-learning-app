# AmigosNest 42s social video — shot list + capture guide

Nothing here regenerates your story art. Place YOUR 7 images, capture REAL
app UI, then run one command. Dialogue is your own recorded takes
(`video/audio/`), mixed over a generated bed — no synthesised voice.

## 1. Drop in your 7 story shots (exact names)

```
video/shots/01-question.png        0-4.6s   THE QUESTION (slow zoom to child)
video/shots/02-mom-asks.png        4.6-8.2s DON'T GIVE THE ANSWER (drift to mother)
video/shots/03-thinking.png        8.2-12.8s THINKING (gentle zoom to child)
video/shots/04-encouragement.png   12.8-17.4s ENCOURAGE (calm drift)
video/shots/05-discovery.png       17.4-22s DISCOVERY (payoff, let it breathe)
video/shots/06-product.png         22-23.9s + 36.6-37s PRODUCT CONTEXT (see note)
video/shots/07-ending.png          37-41.6s FINAL MESSAGE + CTA + logo + words
```

`Shot*.jpeg` also works (the assembler falls back to those names).

> `06-product.png` = mother + daughter together with the laptop visible.
> The edit reuses YOUR shot 6 as the context bookend and cuts the REAL
> screenshots inside it (22-36.5s). No tablet, no generic UI, no redraw.
> For shot 6, mother showing the laptop screen to the daughter is ideal.

## 2. Capture REAL AmigosNest screenshots (no fake UI)

You need the dev server + Ollama running (same as `npm run evaluate:ask`):

```powershell
npm run dev          # terminal 1 — http://localhost:3000
```

Then, in this order (so quiz/ask build on the same material):

1. **Lesson** — open `/lesson`, generate a short lesson about elephants
   (e.g. topic "Elephant trunks", age 8). Screenshot the entry state and the
   generated lesson. Save as `video/assets/LessonPart1.PNG` and
   `video/assets/LessonPart2.PNG`. (Already captured — reuse as-is.)
2. **Quiz** — open `/quiz`, same topic, 3 questions. Screenshot the setup,
   the questions, and the submit state. Save as `video/assets/QuizPart1.PNG`,
   `video/assets/QuizPart2.PNG`, `video/assets/QuizPart3.PNG`.
   (Already captured — reuse as-is.)
3. **Ask** — open `/ask`, ask "Why does an elephant have such a long
   trunk?" and answer the guiding question once, so the Socratic
   turn is visible. Screenshot both parts. Save as `video/assets/AskPart1.PNG`
   and `video/assets/AskPart2.PNG`. (Already captured — reuse as-is.)
4. **Parent dashboard** — `video/assets/ParentsDashboard.PNG` showing
   `Elephants.txt` uploaded. (Already captured — reuse as-is.)
5. **Logo** — `video/assets/logo.PNG` (owl + "Meet AmigosNest!").
   (Already captured — reuse as-is.)

Capture tips: desktop Chrome at 1280x800, no bookmarks bar, scroll the
result card to the top. Landscape is fine — the assembler does NOT shrink the
whole capture into 9:16. Each product beat is cropped to the one element that
carries it (`UI_CROPS` in `scripts/social-video/assemble-shots.mjs`) and fitted
into a 1040x1300 box, so the crop decides the zoom (1.19x-1.98x today, printed
in the render log). If a screen still reads too small on a phone, tighten that
screen's crop rect rather than lengthening the beat — the big on-screen label
("Learn", "Practice", "Ask", "Think") carries the meaning either way.

Or semi-auto (Playwright, still needs dev server + Ollama):

```powershell
npm run video:social:capture
```

This opens each page at 1280x800 and saves full-page PNGs to
`video/assets/*.png` — you then crop/confirm the best frames.

## 3. Render

```powershell
npm run video:social:shots
```

Output: `video/out/AmigosNest_42sec_social.mp4`
1080x1920, 30fps, H.264 + AAC, exactly 41.6s (16 segments, 15 xfades of 0.4s).

What the edit contains:
* story 0-22.4s (dialogue beats), product 22.5-36.5s (8 screens, 2.2s each),
  closing 37-41.6s (message + logo + CTA).
* persistent owl + wordmark watermark, top right, from 0.5s to the end.
* "Join the waitlist - link in bio" CTA pill for the final 2.6s.

QC before posting: duration, no black bars, no stretched faces, subtitles
readable on a phone, lesson/quiz/ask recognisable as REAL UI, each product
screen on screen for its full beat, CTA visible >= 2s, watermark legible on
both light and dark shots, final message readable >= 1s.

## 4. Audio (your recorded takes — no synthesised voice)

`video/audio/01-daughter.mp3` ... `05-daughter.mp3` are wired into the render.
Each take is trimmed to the spoken part (measured with ffmpeg `silencedetect`),
gain-matched (mother vs daughter sit ~7dB apart raw) and cued inside its story
beat — all three live in the `DIALOGUE` table in
`scripts/social-video/assemble-shots.mjs`. Swap a file and re-render; only the
trim/gain/cue numbers may need a nudge.

```
video/audio/01-daughter.mp3  @0.55s  "Mom, why does an elephant have such a long trunk?"
video/audio/02-mother.mp3    @5.05s  "Hmm... what do you think?"
video/audio/03-daughter.mp3  @8.85s  "Maybe... it helps the elephant reach things?"
video/audio/04-mother.mp3    @13.3s  "Yes. What else could it help with?"
video/audio/05-daughter.mp3  @17.95s "It can drink, pick up food... and even touch things!"
video/audio/music.m4a        optional: your own royalty-free bed (warm, quiet)
```

Timestamps are in `video/audio/placeholder-specs.txt`. Without `music.m4a` the
render generates a quiet offline bed (`scripts/social-video/audio.mjs`, I-V-vi-IV
pad) so dialogue always sits on top. Product + closing beats stay music-only.

