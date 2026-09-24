# "AI shouldn't do your child's thinking" — 35s vertical script

Format: 1080×1920 (9:16) · 35.0s · 30fps · captions burned in
Voice: warm mother + 9–10 year old daughter + calm AI + narrator (all local)
Every frame of the rendered cut comes from `scripts/social-video/lines.mjs`, so this
document and the MP4 cannot drift apart — edit the script there, not here.

Legend — **VO** spoken line · **TXT** on-screen text · **PIC** picture direction

---

## 1 · 0.0 – 3.4s — Hook: the homework question

**VO** (daughter, curious): *"Mom… why do plants need sunlight?"*
**TXT** chip top-left: *Why do plants need sunlight?*
**PIC** Kitchen table at golden hour. Daughter in mustard, pencils and worksheet,
question still blank. Mother looks up from her chai, warm and unhurried.
Camera: slow push in from the table toward the two of them.

## 2 · 3.4 – 7.6s — The hand-off

**VO** (mother, warm): *"Good question. Why don't you ask AI?"*
**PIC** She slides the laptop over — not to be rid of the question, to give the child
a tool. Daughter turns to the screen. No judgement in either face.

## 3 · 7.6 – 12.1s — The perfect answer (deliberately empty)

**TXT** laptop screen: a wall of grey body text under the heading
*Photosynthesis — overview*. No figures, no explanation.
**VO** (daughter, flat): *"Oh… okay."*
**PIC** She reads, then goes still. Colour drains out of the room — everything is
technically answered and nothing is understood. Hold the emptiness a beat longer
than is comfortable.

## 4 · 12.1 – 15.5s — Answer ≠ understanding

**TXT** split screen: **AN ANSWER** (grey wall of text, *"Sorted. Next question."*)
vs **UNDERSTANDING** (sun, healthy plant, *"Because the leaf uses light to make
food."*, *"She can explain it tomorrow."*)
**VO** (narrator, plain): *"Getting an answer isn't the same as learning."*
**PIC** Card covers the room. Left half dead grey, right half growing green.

## 5 · 15.5 – 21.2s — She asks again — and the tool asks back

**TXT** laptop screen: *"What do you think happens to a plant kept in the dark for
a few days?"*
**VO** (AI, calm): same line.
**PIC** Cut back to the room, colour returns in a single breath. Daughter leans on
her chin and actually thinks. The room answers nothing for her.

## 6 · 21.2 – 27.0s — The thinking sequence

**PIC** Thought bubble above her head: three days in a dark cupboard, the plant
yellowing → light returns, the plant stands up, sparkles. Label under the bubble:
*"it needs light to make its own food"*.
**VO** (daughter, working it out): *"It couldn't make food… because it needs sunlight?"*
**VO** (mother, proud): *"Exactly."* — soft chime on the word.
**PIC** Her face opens up. Mother's hand rests on her shoulder.

## 7 · 27.0 – 31.4s — The message

**TXT** card 1: *"AI shouldn't do your child's thinking."*
**TXT** card 2: *"It should help them think."* 🧠
**PIC** The room, desaturated behind the words. No voice — let the sentence land.

---

## Shot prompts for a generative-video tool (if this is ever re-shot)

One prompt per shot. Keep wardrobe, palette and light identical so the shots cut
together; ask for *no on-screen text* (captions belong in the edit) and 24fps+.
The current cut is fully vector-illustrated, so a photoreal re-shoot is a different
creative direction — not an upgrade.

1. **Hook** — "2D flat-vector illustration, warm Indian kitchen at golden hour,
   9-year-old girl in mustard yellow kurta with braided hair holding a pencil over a
   school worksheet, mother in teal kurta with bun and small earrings holding a cup
   of chai, soft cream walls, houseplant on the sill, gentle camera push-in, calm and
   cosy, no text, vertical 9:16"
2. **Hand-off** — "same kitchen, same characters: mother turns a small silver laptop
   toward her daughter, daughter turns to look at the screen, gentle side dolly, warm
   rim light, no text, vertical 9:16"
3. **The empty answer** — "same kitchen drained of colour, desaturated grey-beige,
   daughter staring at a laptop screen filled with a featureless block of grey text,
   she goes still, slow zoom toward the screen, slightly lonely mood, no readable
   text, vertical 9:16"
4. **Graphic card** — "flat-vector infographic split in two: left side grey
   monochrome 'answer' tile with a wall of grey text bars and a wilting grey plant,
   right side fresh green tile with a sun and a healthy potted plant, cream
   background, generous margins, vertical 9:16"
5. **Ask-back** — "flat-vector illustration, mother types a question into the laptop,
   daughter leans on her chin, colour returning to the room, spark of curiosity,
   warm light, no readable text, vertical 9:16"
6. **Thinking sequence** — "flat-vector scene: thought bubble above a girl's head
   showing a plant in a dark cupboard that wilts, then the same plant in sunlight
   standing up with sparkles, mother's hand on the girl's shoulder, warm golden
   light, hopeful, vertical 9:16"
7. **Message card** — "flat-vector, characters held in soft focus behind a
   desaturated overlay, generous empty space for large text, warm cream palette,
   vertical 9:16"
8. **End card** — "flat-vector logo lockup: friendly brown owl sitting in a woven
   nest with cream eggs, warm gold glow behind, cream background, lots of empty
   space below for a wordmark, vertical 9:16"

## Alternate cuts

* **20s cut (Reels / TikTok / Shorts):** keep shots **1, 3, 6, 7, 8**; drop the
  split screen and the ask-back. Set `TARGET_SECONDS = 20` in
  `scripts/social-video/lines.mjs` and let the pauses rescale.
* **40s cut (calmer, more human pace):** set `TARGET_SECONDS = 40`. All the measured
  speech stays exactly as it is — only the pauses grow.
* **Human voiceover:** record the seven lines (the timeline print-out gives you the
  exact text and start times; `artifacts/social-video/work/voice/*.wav` works as a
  scratch guide), save them over the same file names, then render with
  `npm run video:social -- --reuse-voiceover`. Nothing else changes: the timeline is
  rebuilt from whatever the WAV files measure.

## Product truths this film keeps

* The ask-back behaviour is the product, not a garnish: the tool answers a question
  with a question so the child keeps the reasoning.
* The "empty answer" shot is the honest part of the pitch — a technically correct
  answer nobody understands is not learning.
* No capability claims on screen; the product name appears exactly once, on the end
  card.


## 8 · 31.4 – 35.0s — Brand frame

**TXT** logo: **AmigosNest** · *An AI thinking companion for kids.*
**PIC** Warm glow, owl in its nest, nothing else on screen. End card holds 3.6s so
the name is readable after the last cut.
