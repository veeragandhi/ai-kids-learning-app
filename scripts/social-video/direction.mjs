/**
 * Creative direction -> machine-readable cue list.
 *
 * The stage (marketing/social-video/amigosnest-35s.html) is a dumb renderer: it
 * only knows how to apply cues like `expr`, `laptop`, `caption`, `overlay`,
 * `camera`. All the storytelling decisions (when the room drains of colour, when
 * the plant sees light, which beat gets a chime) live here, so the animation and
 * the audio mix can never disagree about timing.
 */

import { SCENES, TARGET_SECONDS, PREROLL_SECONDS, FPS } from "./lines.mjs";

/** Seconds of silence before the first spoken beat of a scene (visual setup). */
const LEAD = { s1: 0.35, s2: 0.4, s3: 1.9, s4: 0.4, s5: 1.0, s6: 0.6 };

/** Camera framing per scene, focus point in stage coordinates. */
const CAMERA = {
  s1: { from: { x: 540, y: 900, scale: 1.0 }, to: { x: 440, y: 830, scale: 1.06 } },
  s2: { from: { x: 470, y: 860, scale: 1.06 }, to: { x: 706, y: 800, scale: 1.09 } },
  s3: { from: { x: 700, y: 900, scale: 1.06 }, to: { x: 540, y: 1176, scale: 1.13 } },
  s4: { from: { x: 540, y: 960, scale: 1.02 }, to: { x: 540, y: 960, scale: 1.0 } },
  s5: { from: { x: 540, y: 1080, scale: 1.02 }, to: { x: 540, y: 1240, scale: 1.1 } },
  s6: { from: { x: 540, y: 980, scale: 1.04 }, to: { x: 520, y: 620, scale: 1.1 } },
  s7: { from: { x: 540, y: 900, scale: 1.05 }, to: { x: 540, y: 880, scale: 1.02 } },
  s8: { from: { x: 540, y: 960, scale: 1.0 }, to: { x: 540, y: 960, scale: 1.0 } },
};

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {Record<string, number>} voiceDurations seconds of rendered speech per beat file name
 * @param {{ scriptPath?: string }} [options]
 * @returns timeline object consumed by the stage and by the audio mix
 */
export function buildTimeline(voiceDurations, options = {}) {
  const warnings = [];

  // ── pass 1: measure ────────────────────────────────────────────────────────
  let speechTotal = 0;
  let leadTotal = 0;
  let padTotal = 0;
  let cardTotal = 0;
  const measured = SCENES.map((scene) => {
    const lead = scene.beats.length ? LEAD[scene.id] ?? 0.35 : 0;
    const beats = scene.beats.map((beat, index) => {
      const fileName = `${scene.id}-${beat.speaker}-${index}.wav`;
      const vo = voiceDurations[fileName] ?? estimateSeconds(beat.text);
      speechTotal += vo;
      padTotal += beat.pad;
      return { ...beat, fileName, vo, hold: beat.pad };
    });
    const cards = (scene.cards ?? []).map((card) => {
      cardTotal += card.hold;
      return { card, hold: card.hold };
    });
    leadTotal += lead;
    return { scene, lead, beats, cards };
  });

  // Card holds are reading time for the closing message, so they stay fixed.
  // Spoken lines keep their natural pace too; only the pauses between spoken
  // beats are stretched or squeezed so the cut lands exactly on TARGET_SECONDS.
  const slack = TARGET_SECONDS - leadTotal - speechTotal - cardTotal;
  if (slack <= 0) {
    warnings.push(
      `Speech (${round(speechTotal)}s) + closing cards (${round(cardTotal)}s) + scene lead-ins (${round(leadTotal)}s) exceed the ${TARGET_SECONDS}s cut — no room left for pauses. Shorten a line or raise TARGET_SECONDS.`,
    );
  }
  if (slack < 1.2) {
    warnings.push(
      `Only ${round(Math.max(0, slack))}s of pause is left in the ${TARGET_SECONDS}s cut; the "answer arrives" and "thinking" beats will feel rushed.`,
    );
  }
  const factor = padTotal > 0 ? Math.max(0.15, slack / padTotal) : 1;

  // ── pass 2: lay scenes out on one clock ────────────────────────────────────
  const scenes = [];
  const cues = [];
  const events = [];
  let clock = 0;

  for (const entry of measured) {
    const { scene, lead, beats, cards } = entry;
    const start = clock;
    const cueList = [];

    if (beats.length) {
      let t = start + lead;
      for (const beat of beats) {
        cueList.push({
          kind: "caption",
          at: round(t),
          value: { speaker: beat.speaker, text: beat.text, on: true },
        });
        cueList.push({ kind: "captionEnd", at: round(t + beat.vo), value: null });
        if (beat.sfx) events.push({ type: beat.sfx, at: round(t) });
        t += beat.vo + beat.hold * factor;
      }
      clock = t;
    } else {
      let t = start;
      cards.forEach((card, index) => {
        cueList.push({ kind: "card", at: round(t), value: { scene: scene.id, index } });
        t += card.hold;
      });
      clock = t;
    }

    const duration = round(clock - start);
    const beatsByStart = cueList.filter((c) => c.kind === "caption" && c.value.on);
    scenes.push({ id: scene.id, start, duration, cueList, beats: beatsByStart });
    for (const cue of cueList) cues.push(cue);
  }

  // ── pass 3: direction (camera, expressions, overlays, sound) ───────────────
  const byId = new Map(scenes.map((s) => [s.id, s]));
  for (const scene of SCENES) {
    const laid = byId.get(scene.id);
    if (!laid) continue;
    directScene({ scene, laid, cues, events, warnings });
  }

  return {
    target: TARGET_SECONDS,
    preroll: PREROLL_SECONDS,
    fps: FPS,
    cardCopy: cardCopy(),
    scenes: scenes.map((s) => ({ id: s.id, start: round(s.start), duration: s.duration })),
    cues: cues.sort((a, b) => a.at - b.at),
    events: events.sort((a, b) => a.at - b.at),
    warnings,
  };
}

/** Fallback duration (seconds) when a line has no measured render yet. */
export function estimateSeconds(text) {
  const words = text.trim().split(/\s+/).length;
  return round(Math.max(1.1, words * 0.38 + 0.35));
}

/** Copy for the two closing cards + the brand frame. */
export function cardCopy() {
  return {
    s7: [
      { l1: "AI shouldn't do", l2: "your child's thinking.", icon: false, bg: 0.62 },
      { l1: "It should help them think.", l2: "", icon: true, bg: 0.72 },
    ],
    s8: [{ l1: "AmigosNest", l2: "An AI thinking companion for kids.", icon: false, brand: true }],
  };
}

/**
 * Turns one scene's beats into cues: camera moves, expressions, laptop state,
 * overlays, colour drain and transition sound.
 */
function directScene({ scene, laid, cues, events }) {
  const start = laid.start;
  const cam = CAMERA[scene.id];
  const push = (kind, at, value) => cues.push({ kind, at: round(at), value });
  const cueFor = (speaker) =>
    laid.cueList.find((c) => c.kind === "caption" && c.value.speaker === speaker);

  // Camera: settle into the scene, then drift gently for the whole scene.
  if (cam) {
    push("camera", Math.max(0, start - 0.001), { ...cam.from, dur: 0.001 });
    push("camera", start, { ...cam.to, dur: Math.max(1, laid.duration - 0.2) });
  }

  switch (scene.id) {
    case "s1":
      push("overlay", start, { name: "hook", on: true });
      push("expr", start, { who: "daughter", expr: "asking", arm: "write" });
      push("expr", start, { who: "mother", expr: "warm", arm: "desk" });
      push("laptop", start, { state: "idle" });
      push("tint", start, { value: 0 });
      break;

    case "s2":
      push("overlay", start - 0.3, { name: "hook", on: false });
      push("expr", start, { who: "daughter", expr: "pose", arm: "idle" });
      push("expr", start + 0.2, { who: "mother", expr: "talk", arm: "point" });
      break;

    case "s3":
      push("expr", start, { who: "mother", expr: "warm", arm: "desk" });
      push("laptop", start + 0.35, { state: "asking" });
      push("tint", start + 0.9, { value: 0.36 });
      push("laptop", start + 1.7, { state: "answer" });
      push("sfxVisual", start + 1.7, { pulse: true });
      push("expr", start + 2.3, { who: "daughter", expr: "flat", arm: "idle" });
      events.push({ type: "tick", at: round(start + 0.4) });
      events.push({ type: "whoosh", at: round(start + 1.6) });
      break;

    case "s4":
      push("overlay", start - 0.4, { name: "split", on: true });
      push("expr", start, { who: "daughter", expr: "flat", arm: "idle" });
      break;

    case "s5": {
      const aiLine = cueFor("ai");
      push("overlay", start, { name: "split", on: false });
      push("tint", start, { value: 0.08 });
      push("laptop", start + 0.3, { state: "asking" });
      push("expr", start, { who: "daughter", expr: "write", arm: "idle" });
      push("laptop", aiLine ? aiLine.at - 0.5 : start + 1.4, { state: "question" });
      push("expr", aiLine ? aiLine.at + 0.4 : start + 2, { who: "daughter", expr: "think", arm: "idle" });
      events.push({ type: "tick", at: round(start + 0.35) });
      events.push({ type: "tick", at: round(start + 0.75) });
      events.push({ type: "tick", at: round(start + 1.1) });
      break;
    }

    case "s6": {
      const aha = cueFor("daughter");
      const exactly = cueFor("mother");
      const lightAt = aha ? aha.at + 1.1 : start + 2.4;
      push("overlay", start - 0.4, { name: "thought", on: true });
      push("expr", start, { who: "daughter", expr: "think", arm: "chin" });
      push("expr", start, { who: "mother", expr: "warm", arm: "desk" });
      push("think", start, { light: 0, label: "in the dark it cannot make food" });
      push("think", lightAt, { light: 1, label: "it needs light to make its own food" });
      push("expr", lightAt, { who: "daughter", expr: "aha", arm: "chin" });
      if (exactly) push("expr", exactly.at, { who: "mother", expr: "proud", arm: "desk" });
      events.push({ type: "whoosh", at: round(start - 0.2) });
      push("sfxVisual", start + 0.05, { pulse: true });
      break;
    }

    case "s7":
      push("overlay", start - 0.4, { name: "thought", on: false });
      push("overlay", start, { name: "cards", on: true });
      push("expr", start, { who: "daughter", expr: "pose", arm: "idle" });
      push("expr", start, { who: "mother", expr: "hug", arm: "hug" });
      events.push({ type: "whoosh", at: round(start - 0.2) });
      break;

    case "s8":
      push("overlay", start, { name: "cards", on: false });
      push("overlay", start, { name: "brand", on: true });
      break;

    default:
      break;
  }
}
