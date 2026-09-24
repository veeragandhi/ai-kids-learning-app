/**
 * Single source of truth for the AmigosNest social video ("AI shouldn't do your
 * child's thinking"). The renderer, the HTML animation and the written script
 * doc all read from here, so timings and copy never drift apart.
 *
 * Timeline model
 * --------------
 * Every scene has one or more spoken "beats". A scene's duration is the sum of
 * its beat durations plus the scene's `pad` (breathing room / hold on a visual).
 * Beat durations come from the real rendered voiceover so audio and animation
 * stay in sync; the leftover time up to TARGET_SECONDS is spread across the pads
 * by scripts/social-video/render.mjs.
 */

/** Total runtime of the social cut, in seconds. */
export const TARGET_SECONDS = 35;

/** 9:16 vertical master. */
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

/** Black pre-roll recorded before the animation starts; trimmed off in post. */
export const PREROLL_SECONDS = 1.5;

/**
 * Voice profiles. Windows SAPI has no Indian-English voice installed on this
 * machine, so pitch/rate shaping approximates the characters. Swap in a human
 * or ElevenLabs take by dropping 44.1kHz WAVs into the voiceover folder and
 * running the renderer with `--reuse-voiceover`.
 */
export const VOICES = {
  daughter: { sapiVoice: "Microsoft Zira Desktop", rate: 2, pitch: 1.13, label: "Daughter" },
  mother: { sapiVoice: "Microsoft Zira Desktop", rate: 1, pitch: 0.93, label: "Mother" },
  ai: { sapiVoice: "Microsoft David Desktop", rate: 1, pitch: 1.0, label: "AI" },
  narrator: { sapiVoice: "Microsoft David Desktop", rate: 1, pitch: 0.96, label: "Narrator" },
};

/** Caption colours per speaker, used by the caption bar in the HTML stage. */
export const SPEAKER_COLORS = {
  daughter: "#b4622a",
  mother: "#2f6f6a",
  ai: "#5a5f8a",
  narrator: "#6b6357",
};

/**
 * Scene list. `visual` is a short slug the HTML stage maps to a composed frame;
 * `beats[].speaker` drives both the caption colour and the voice profile.
 */
export const SCENES = [
  {
    id: "s1",
    slug: "desk-question",
    title: "Hook — homework about plants",
    visual: "Homework. Warm afternoon light. She is stuck on one line.",
    beats: [
      { speaker: "daughter", text: "Mom… why do plants need sunlight?", pad: 0.9, emotion: "asking" },
    ],
    hook: "Why do plants need sunlight?",
  },
  {
    id: "s2",
    slug: "mother-smiles",
    title: "The hand-off",
    visual: "Mother looks up from her chai, smiles, nods at the laptop.",
    beats: [
      { speaker: "mother", text: "Good question. Why don't you ask AI?", pad: 0.7, emotion: "warm" },
    ],
  },
  {
    id: "s3",
    slug: "perfect-answer",
    title: "The perfect answer (deliberately empty)",
    visual:
      "A wall of textbook text lands instantly. Colour drains out of the room. She reads, blinks, nothing happens.",
    beats: [{ speaker: "daughter", text: "Oh… okay.", pad: 2.2, emotion: "flat" }],
    /** Shown on the laptop screen, not spoken — she *reads* it. */
    screenAnswer:
      "Photosynthesis: chlorophyll absorbs light energy, water and carbon dioxide are converted into glucose and oxygen inside the chloroplasts…",
  },
  {
    id: "s4",
    slug: "answer-vs-learning",
    title: "Answer ≠ understanding",
    visual:
      "Split frame: 'an answer' as a flat grey block; 'understanding' as a plant that grows because she can explain it.",
    beats: [
      {
        speaker: "narrator",
        text: "Getting an answer isn't the same as learning.",
        pad: 0.7,
        emotion: "calm",
      },
    ],
  },
  {
    id: "s5",
    slug: "one-question-back",
    title: "She asks again — AI asks back",
    visual: "She types again. Instead of an answer, a question comes back.",
    beats: [
      {
        speaker: "ai",
        text: "What do you think happens to a plant kept in the dark for a few days?",
        pad: 1.8,
        emotion: "calm",
      },
    ],
    screenPrompt: "What do you think happens to a plant kept in the dark for a few days?",
  },
  {
    id: "s6",
    slug: "discovery",
    title: "The thinking sequence",
    visual:
      "Thought bubble: a plant in a dark cupboard weakens, light returns, it lifts. She connects it to sunlight making food.",
    beats: [
      {
        speaker: "daughter",
        text: "It couldn't make food… because it needs sunlight?",
        pad: 0.35,
        emotion: "aha",
      },
      { speaker: "mother", text: "Exactly.", pad: 1.4, emotion: "proud", sfx: "chime" },
    ],
    visualCaptions: ["dark cupboard → weak, pale leaves", "light back → it can make its own food"],
  },
  {
    id: "s7",
    slug: "message",
    title: "The message",
    visual: "Mother and daughter back at the same worksheet, together. Her own words on the page.",
    beats: [],
    /** Text cards, no voice: let the music carry these two lines. */
    cards: [
      { text: "AI shouldn't do your child's thinking.", hold: 2.4 },
      { text: "It should help them think. 🧠", hold: 2.0 },
    ],
  },
  {
    id: "s8",
    slug: "brand",
    title: "Brand frame",
    visual: "Warm nest mark. Product name appears only here — nothing sells before this.",
    beats: [],
    cards: [{ text: "AmigosNest\nAn AI thinking companion for kids.", hold: 3.6 }],
  },
];

/** Flat beat list in playback order, used by the renderer to build the voiceover. */
export function allBeats() {
  const out = [];
  for (const scene of SCENES) {
    let indexInScene = 0;
    for (const beat of scene.beats) {
      out.push({
        sceneId: scene.id,
        speaker: beat.speaker,
        text: beat.text,
        fileName: beatFileName(scene.id, beat.speaker, indexInScene),
      });
      indexInScene += 1;
    }
  }
  return out;
}

/** Name of the WAV produced for a beat, e.g. `s1-daughter-0.wav`. */
export function beatFileName(sceneId, speaker, indexInScene) {
  return `${sceneId}-${speaker}-${indexInScene}.wav`;
}

/** Words that actually get spoken — used to sanity-check the 35s budget. */
export function summarise() {
  const beats = allBeats();
  return {
    scenes: SCENES.length,
    beats: beats.length,
    words: beats.reduce((n, b) => n + b.text.split(/\s+/).length, 0),
  };
}
