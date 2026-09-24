/**
 * Assemble the AmigosNest 42s vertical social video from YOUR image shots plus
 * REAL AmigosNest captures. Nothing here regenerates your art.
 *
 * Method - ONE ffmpeg pass:
 *   image inputs -> per-image branches (Ken Burns for story art, full-screen
 *   UI card for captures) -> 15 xfades -> caption/label panels + brand chip +
 *   CTA pill -> the five recorded takes mixed over the offline music bed.
 *
 * Why one pass: the previous pipeline encoded 16 segments, then re-encoded the
 * WHOLE accumulated timeline once per crossfade (15 times), then re-encoded
 * again to burn captions and mux audio. That is ~12x more frames encoded than
 * the finished 41.6s - minutes of work on a 2-core CPU. One pass encodes the
 * 41.6s exactly once.
 *
 * Why `loop` / `zoompan d=<frames>` instead of `-loop 1` inputs: with `-loop 1`
 * ffmpeg RE-DECODES the still image for every output frame (~30ms for a
 * 1080x1920 PNG), which capped the render at ~35fps no matter the encoder.
 * Decoding once and repeating the frame in memory (UI cards), or letting
 * zoompan generate <frames> frames from a single input frame (story art),
 * removes that cost.
 *
 * UI beats are never cropped: each capture is shown WHOLE (fitted to the 1080px
 * frame width) on a soft blurred backdrop with an opaque label panel above it.
 * Cropping the app screens to "zoom in" cut off the very rows the beat was
 * about, so now the label carries the meaning and the screen shows all of
 * itself.
 *
 * Inputs (you provide):
 *   video/shots/Shot1.jpeg ... Shot7.jpeg (your 7 story images)
 *   video/assets/ParentsDashboard.PNG, LessonPart1/2.PNG, QuizPart1/2/3.PNG,
 *     AskPart1/2.PNG (REAL app UI - elephant-trunk captures)
 *   video/audio/01-daughter.mp3 ... 05-daughter.mp3 (recorded takes; trimmed +
 *     cued per line in DIALOGUE below, mixed over a gentle bed)
 *
 * Usage:
 *   node scripts/social-video/assemble-shots.mjs
 *
 * Output: video/out/AmigosNest_42sec_social.mp4 (1080x1920, H.264 + AAC)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFfmpeg } from "../convert-to-mp4.mjs";
import { musicBed, SAMPLE_RATE, writeStereoWav } from "./audio.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const SHOTS = path.join(root, "video/shots");
const ASSETS = path.join(root, "video/assets");
const AUDIO = path.join(root, "video/audio");
const OUT = path.join(root, "video/out");
const WORK = path.join(OUT, "work-assemble");
const OUT_FILE = path.join(OUT, "AmigosNest_42sec_social.mp4");

const W = 1080;
const H = 1920;
const FPS = 30;
const XF = 0.4; // cross-dissolve between beats (s)

const UI_DUR = 2.2; // hold per product screen (long enough to actually read)
const LABEL_TOP = 236; // label panel top: clear of platform headers
const CARD_TOP = 452; // full-screen capture band starts under the label
const CARD_BOTTOM = 1730; // ...and stops above the platform's bottom UI
const CARD_H = CARD_BOTTOM - CARD_TOP;
const CARD_W = W; // full-bleed: the whole screen, never a crop
const CAPTION_BOTTOM = 1452; // bottom edge of dialogue caption text
const CTA_BOTTOM = 1560; // bottom edge of the closing CTA pill
const CHIP = { x: 732, y: 56, w: 316, h: 104 }; // top-right brand chip
const OWL_Y = 1080; // closing owl mark sits in the empty band above the wordmark
const OWL_HEIGHT = 150;
const PANEL_BG = "0x0A1020@0.92"; // opaque: text behind must never ghost through
const LABEL_BG = "0x0A1020@0.94";
const PANEL_EDGE = "0xFFFFFF@0.12";
const SAFE_SIDE = 40; // frame margin no panel may cross
const GLYPH_SEMI = 0.6; // Segoe UI Semibold, measured with the bbox filter
const GLYPH_REG = 0.577; // Segoe UI regular, same method
const MUSIC_LEVEL = 0.6; // generated bed stays well under dialogue
const FILTER_THREADS = Number(process.env.FF_FILTER_THREADS) || Math.max(2, Math.min(4, os.cpus().length));

async function runFfmpeg(ffmpeg, args, logName) {
  try {
    await execFileAsync(ffmpeg, ["-hide_banner", ...args], { maxBuffer: 1024 * 1024 * 128 });
  } catch (e) {
    await writeFile(path.join(OUT, logName), String(e.stderr ?? e.stdout ?? e.message ?? e));
    throw new Error("ffmpeg failed (full log in video/out/" + logName + "):\n" + String(e.stderr ?? "").slice(0, 1400));
  }
}

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Reads PNG IHDR width/height - ffmpeg-static ships no probe tool. */
async function pngSize(file) {
  const { readFile } = await import("node:fs/promises");
  const b = await readFile(file);
  if (b.length < 24 || b.toString("ascii", 1, 4) !== "PNG") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Measured width of a line: drawtext cannot report text_w, so estimate it. */
const estWidth = (text, size, glyph) => Math.round(text.length * glyph * size);

/**
 * drawtext never wraps. Balance long text into lines that clear the frame with
 * the panel padding, using the same measured glyph factor.
 */
function wrapText(text, size, glyph, maxW) {
  const clean = text.split(/\s+/).filter(Boolean).join(" ");
  if (estWidth(clean, size, glyph) <= maxW) return [clean];
  const maxChars = Math.ceil(clean.length / Math.ceil(estWidth(clean, size, glyph) / maxW)) + 4;
  const out = [];
  let cur = "";
  for (const word of clean.split(" ")) {
    const cand = cur ? cur + " " + word : word;
    if (cand.length <= maxChars) cur = cand;
    else {
      if (cur) out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const esc = (t) => t.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/'/g, "\\\\\\'");

/**
 * Every text block rendered so far, with the rectangle it occupies. Used to
 * prove that two messages can never sit in the same place at the same time -
 * the old cut stacked translucent per-line boxes, which is what produced the
 * grey "shadow" bands across multi-line captions.
 */
const BLOCKS = [];

/**
 * One text BLOCK = ONE opaque panel + one drawtext per line, sharing a single
 * time window.
 *
 * The old code drew the panel per line with `drawtext box=1`, so the
 * translucent boxes of stacked lines overlapped each other and every multi-line
 * caption showed a grey band (a "shadow") across its own text. The panel is now
 * drawn once with drawbox and the lines sit on top of it, and no two blocks may
 * share screen space at the same time (see assertNoTextCollision).
 */
function panel(lines, o) {
  const items = lines.map((l) =>
    typeof l === "string"
      ? { text: l, size: o.size, color: o.color, font: o.font, glyph: o.glyph ?? GLYPH_SEMI }
      : { glyph: o.glyph ?? GLYPH_SEMI, font: o.font, ...l },
  );
  const pitch = o.pitch ?? Math.round(o.size * 1.36);
  const padX = o.padX ?? 42;
  const padY = o.padY ?? Math.round(o.size * 0.44);
  const widest = Math.max(...items.map((l) => estWidth(l.text, l.size, l.glyph)));
  const tallest = Math.max(...items.map((l) => l.size));
  const w = Math.min(W - 2 * SAFE_SIDE, even(widest + 2 * padX));
  const h = even((items.length - 1) * pitch + tallest + 2 * padY);
  const x = even((W - w) / 2);
  const y = o.bottom != null ? Math.round(o.bottom - h) : Math.round(o.top);
  const en = `enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'`;
  const box =
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${o.bg ?? PANEL_BG}:t=fill:${en}` +
    `,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${PANEL_EDGE}:t=2:${en}`;
  const text = items.map(
    (line, i) =>
      `drawtext=fontfile='${line.font}':text='${esc(line.text)}':fontsize=${line.size}:fontcolor=${line.color}` +
      `:x=(w-text_w)/2:y=${y + padY + i * pitch}:${en}`,
  );
  BLOCKS.push({ name: o.name, start: o.start, end: o.end, x, y, w, h });
  return [box, ...text].join(",");
}

/**
 * The five recorded takes in video/audio/ (see placeholder-specs.txt).
 * `trim` cuts the measured lead-in/lead-out silence (ffmpeg silencedetect),
 * `gainDb` levels mother (takes 2/4) against daughter (1/3/5) - the raw takes
 * differ by ~7dB - and `cue` places the spoken line inside its story beat.
 */
const DIALOGUE = [
  { file: "01-daughter.mp3", whom: "Daughter", trim: [0.40, 2.95], gainDb: 2.9, cue: 0.55 },
  { file: "02-mother.mp3", whom: "Mother", trim: [0.12, 1.52], gainDb: 0.6, cue: 5.05 },
  { file: "03-daughter.mp3", whom: "Daughter", trim: [0.45, 2.80], gainDb: 4.8, cue: 8.85 },
  { file: "04-mother.mp3", whom: "Mother", trim: [0.10, 2.12], gainDb: -2.3, cue: 13.30 },
  { file: "05-daughter.mp3", whom: "Daughter", trim: [0.05, 3.45], gainDb: 2.1, cue: 17.95 },
];

/**
 * Fails the render if two text blocks ever overlap in BOTH time and space.
 * Two messages in different zones (a tagline up top, a CTA pill at the bottom)
 * are fine; two messages fighting over the same pixels are not.
 */
function assertNoTextCollision(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      const sameTime = a.start < b.end - 0.001 && b.start < a.end - 0.001;
      if (!sameTime) continue;
      const sameSpace =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (sameSpace) {
        throw new Error(
          "text collision: '" + a.name + "' (" + a.start + "-" + a.end + "s) and '" + b.name +
          "' (" + b.start + "-" + b.end + "s) overlap on screen at x" + a.x + " y" + a.y +
          " / x" + b.x + " y" + b.y,
        );
      }
    }
  }
}




/**
 * Beat sheet. Story beats use your art with a slow Ken Burns push; UI beats show
 * a real app capture whole (never cropped) on a blurred backdrop.
 * `dur` is trimmed so the 15 cross-dissolves land the total on 41.6s.
 */
const BEATS = [
  { kind: "art", src: "Shot1.jpeg", dur: 5.0 },
  { kind: "art", src: "Shot2.jpeg", dur: 4.0 },
  { kind: "art", src: "Shot3.jpeg", dur: 5.0 },
  { kind: "art", src: "Shot4.jpeg", dur: 5.0, zoomIn: false },
  { kind: "art", src: "Shot5.jpeg", dur: 5.0 },
  { kind: "art", src: "Shot6.jpeg", dur: 0.5 },
  { kind: "ui", src: "ParentsDashboard.PNG", dur: UI_DUR, label: "Parent Dashboard", sub: "Her upload, approved before it teaches" },
  { kind: "ui", src: "LessonPart1.PNG", dur: UI_DUR, label: "Learn", sub: "Her question becomes a real lesson" },
  { kind: "ui", src: "LessonPart2.PNG", dur: UI_DUR, label: "Learn", sub: "Short, sourced, in plain words" },
  { kind: "ui", src: "QuizPart1.PNG", dur: UI_DUR, label: "Practice", sub: "A quick quiz on the same lesson" },
  { kind: "ui", src: "QuizPart2.PNG", dur: UI_DUR, label: "Practice", sub: "Grounded in the lesson she just read" },
  { kind: "ui", src: "QuizPart3.PNG", dur: UI_DUR, label: "Practice", sub: "See what actually stuck" },
  { kind: "ui", src: "AskPart1.PNG", dur: UI_DUR, label: "Ask", sub: "She asks - AmigosNest asks back" },
  { kind: "ui", src: "AskPart2.PNG", dur: UI_DUR, label: "Think", sub: "Gentle guidance, never a lecture" },
  { kind: "art", src: "Shot6.jpeg", dur: 0.5 },
  { kind: "art", src: "Shot7.jpeg", dur: 5.0 },
];

/** Cross-dissolve timeline: each beat overlaps the previous one by XF seconds. */
const timeline = [];
{
  let cursor = 0;
  for (const beat of BEATS) {
    if (cursor > 0) cursor -= XF;
    timeline.push({ ...beat, start: Math.round(cursor * 100) / 100 });
    cursor += beat.dur;
  }
}
const t = (i) => timeline[i].start;
const TOTAL = Math.round((t(BEATS.length - 1) + BEATS[BEATS.length - 1].dur) * 10) / 10;
const DUR = timeline.map((b) => b.dur);

/**
 * Text windows. One block per window, and the five recorded takes are cued to
 * the same story beats (see DIALOGUE), so caption and voice always agree.
 */
const STORY_WINDOWS = [
  { name: "ask", start: 0.5, end: t(1) - 0.2 }, // 0.50 - 4.40  the question
  { name: "mom-think", start: t(1) + 0.2, end: t(2) - 0.2 }, // 4.80 - 8.00
  { name: "guess", start: t(2) + 0.3, end: t(3) - 0.2 }, // 8.50 - 12.60
  { name: "mom-more", start: t(3) + 0.4, end: t(3) + 2.6 }, // 13.20 - 15.40
  { name: "explore", start: t(3) + 2.8, end: t(4) - 0.2 }, // 15.60 - 17.20
  { name: "list", start: t(4) + 0.3, end: t(5) - 0.6 }, // 17.70 - 21.40
  { name: "tagline", start: t(15) + 0.2, end: t(15) + 3.4 }, // 36.80 - 40.00
];
const UI_WINDOWS = timeline.slice(6, 14).map((b, i) => ({
  name: "ui-" + (i + 1),
  start: b.start,
  end: t(7 + i) - 0.05,
}));
const CTA_WINDOW = { name: "cta", start: t(15) + 2.4, end: Math.min(TOTAL - 0.2, t(15) + 4.6) };
const ALL_WINDOWS = [...STORY_WINDOWS, ...UI_WINDOWS, CTA_WINDOW];


/** Prefer Semibold for display text, regular for supporting lines. */
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/seguisb.ttf",
  "C:/Windows/Fonts/seguibl.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/ariblk.ttf",
];
const FONT_REGULAR_CANDIDATES = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"];

async function firstExisting(paths) {
  for (const p of paths) if (await exists(p)) return p;
  return null;
}

/**
 * A real app screen, shown WHOLE on a soft blurred version of itself.
 * The capture is scaled to the frame width (never cropped), centred in an
 * 8px-bordered band, and held as a single decoded frame (`loop` + `fps`)
 * instead of being re-decoded for every output frame.
 */
function uiCard(idx, from, dur, size) {
  const fitW = CARD_W - 8;
  const cardW = even(size.w * (fitW / size.w));
  const cardH = even(size.h * (fitW / size.w));
  const x = even((W - cardW) / 2);
  // Overlay + border run BEFORE the pad to full height, so both live in the
  // CARD_W x CARD_H backdrop space (CARD_TOP is only added by pad).
  const oy = Math.max(0, Math.round((CARD_H - cardH) / 2));
  const bw = 90;
  const bh = even((CARD_H / CARD_W) * bw);
  const frames = Math.max(1, Math.round(dur * FPS) + 6);
  return (
    `[${from}:v]format=rgb24,scale=${CARD_W}:${CARD_H}:force_original_aspect_ratio=increase,crop=${CARD_W}:${CARD_H},` +
    `scale=${bw}:${bh},gblur=sigma=9,scale=${CARD_W}:${CARD_H}:flags=bilinear,setsar=1,` +
    `drawbox=x=14:y=14:w=iw-28:h=ih-28:color=0x05080F@0.45:t=fill,split=2[ub${idx}][uf${idx}];` +
    `[ub${idx}]drawbox=x=0:y=0:w=iw:h=ih:color=0x080C18@0.72:t=fill[ubg${idx}];` +
    `[uf${idx}]scale=${cardW}:${cardH}:flags=lanczos,setsar=1[ufs${idx}];` +
    `[ubg${idx}][ufs${idx}]overlay=x=${x}:y=${oy},` +
    `drawbox=x=${x - 5}:y=${oy - 5}:w=${cardW + 10}:h=${cardH + 10}:color=0xFFFFFF@0.20:t=2,` +
    `pad=${W}:${H}:0:${CARD_TOP}:color=0x080C18,fps=${FPS},loop=loop=${frames}:size=1:start=0,` +
    `setsar=1,format=yuv420p[seg${idx}]`
  );
}

/** A story shot with a slow Ken Burns push (single decode, zoompan makes frames). */
function artBranch(idx, from, dur, zoomIn) {
  const frames = Math.max(1, Math.round(dur * FPS) + 8);
  const z = zoomIn ? `1.0+0.10*on/${frames}` : `1.08-0.08*on/${frames}`;
  return (
    `[${from}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},` +
    `format=yuv420p[seg${from}]`
  );
}


async function main() {
  const started = Date.now();
  const ffmpeg = await resolveFfmpeg();
  const font = await firstExisting(FONT_CANDIDATES);
  const fontReg = (await firstExisting(FONT_REGULAR_CANDIDATES)) ?? font;
  if (!font) throw new Error("No display font found. Expected one of: " + FONT_CANDIDATES.join(", "));

  await mkdir(OUT, { recursive: true });
  await mkdir(WORK, { recursive: true });

  for (const beat of BEATS) {
    beat.path = path.join(beat.kind === "ui" ? ASSETS : SHOTS, beat.src);
    if (!(await exists(beat.path))) {
      throw new Error("Missing " + (beat.kind === "ui" ? "app capture" : "story shot") + ": " + beat.path);
    }
    if (beat.kind === "ui") {
      beat.size = await pngSize(beat.path);
      if (!beat.size) throw new Error("Not a readable PNG: " + beat.path);
    }
  }
  for (const d of DIALOGUE) {
    d.path = path.join(AUDIO, d.file);
    if (!(await exists(d.path))) throw new Error("Missing recorded take: " + d.path);
  }
  const logoPath = (await exists(path.join(ASSETS, "logo.PNG"))) ? path.join(ASSETS, "logo.PNG") : null;

  const bedFile = path.join(WORK, "music-bed.wav");
  if (process.env.ASM_DEBUG) {
    console.error("TOTAL=" + TOTAL + " UI_DUR=" + UI_DUR + " FPS=" + FPS);
    console.error("starts=" + timeline.map((b, i) => i + ":" + b.start + "/" + b.dur).join(" "));
  }
  {
    const bed = musicBed(Math.ceil(TOTAL) + 2);
    const interleaved = new Float32Array(bed.left.length * 2);
    for (let i = 0; i < bed.left.length; i++) {
      interleaved[i * 2] = bed.left[i];
      interleaved[i * 2 + 1] = bed.right[i];
    }
    await writeStereoWav(bedFile, interleaved, SAMPLE_RATE);
  }

  // ---- inputs: 15 stills (your art + real app captures), 5 takes, bed, owl ----
  const inputs = [];
  BEATS.forEach((b) => inputs.push("-framerate", String(FPS), "-i", b.path));
  DIALOGUE.forEach((d) => inputs.push("-i", d.path));
  const musicIdx = BEATS.length + DIALOGUE.length;
  inputs.push("-i", bedFile);
  const logoIdx = logoPath ? musicIdx + 1 : -1;
  if (logoPath) inputs.push("-framerate", "1", "-i", logoPath);

  // ---- per-beat branches ----
  const branches = BEATS.map((b, i) => (b.kind === "ui" ? uiCard(i, i, b.dur, b.size) : artBranch(i, i, b.dur, b.zoomIn)));

  // ---- 15 cross-dissolves = the whole timeline in ONE encode ----
  // The old pipeline wrote every intermediate timeline to disk, so each of the
  // 15 dissolves re-encoded all the video before it (~12x the frames of the
  // final 41.6s, plus three stacked H.264 generations). xfade chains the
  // branches inside a single filter graph instead.
  const dissolve = [];
  {
    let prev = "seg0";
    let acc = DUR[0];
    for (let i = 1; i < BEATS.length; i++) {
      const out = i === BEATS.length - 1 ? "tl" : "xf" + i;
      dissolve.push(`[${prev}][seg${i}]xfade=transition=fade:duration=${XF}:offset=${(acc - XF).toFixed(2)}[${out}]`);
      acc = acc - XF + DUR[i];
      prev = out;
    }
  }

  // ---- captions: the spoken lines, one opaque panel each, never stacked ----
  const captions = [
    { w: STORY_WINDOWS[0], speaker: "DAUGHTER", text: "Mom, why does an elephant have such a long trunk?", size: 40 },
    { w: STORY_WINDOWS[1], speaker: "MOM", text: "Hmm... what do you think?", size: 44 },
    { w: STORY_WINDOWS[2], speaker: "DAUGHTER", text: "Maybe... it helps the elephant reach things?", size: 40 },
    { w: STORY_WINDOWS[3], speaker: "MOM", text: "Yes. What else could it help with?", size: 42 },
    { w: STORY_WINDOWS[4], text: "Think. Explore. Discover.", size: 44, color: "0xFFE1A8" },
    { w: STORY_WINDOWS[5], speaker: "DAUGHTER", text: "It can drink, pick up food... and even touch things!", size: 40 },
  ].map((c) => {
    const items = [];
    if (c.speaker) items.push({ text: c.speaker, size: 26, color: "0xF2C57C" });
    items.push({ text: c.text, size: c.size, color: c.color ?? "white" });
    const lines = items.flatMap((it) =>
      wrapText(it.text, it.size, GLYPH_SEMI, W - 2 * SAFE_SIDE - 150).map((text) => ({ ...it, text })),
    );
    return panel(lines, {
      name: c.w.name,
      size: c.size,
      color: c.color ?? "white",
      font,
      start: c.w.start,
      end: c.w.end,
      bottom: CAPTION_BOTTOM,
      pitch: Math.round(c.size * 1.4),
      padY: 26,
    });
  });

  // ---- app-beat labels; the capture below is shown whole, never cropped ----
  const labels = UI_WINDOWS.map((w, i) => {
    const beat = timeline[6 + i];
    const items = [{ text: beat.label, size: 46, color: "white" }];
    if (beat.sub) items.push({ text: beat.sub, size: 28, color: "0xF2C57C", font: fontReg, glyph: GLYPH_REG });
    return panel(items, {
      name: w.name,
      size: 46,
      color: "white",
      font,
      start: w.start,
      end: w.end,
      top: LABEL_TOP,
      bg: LABEL_BG,
      pitch: 58,
      padX: 40,
      padY: 24,
    });
  });

  // ---- closing message (Shot7): the line the whole video exists for ----
  const tagline = panel(
    [
      { text: "Give children a place to think,", size: 48, color: "0xFFF7EA" },
      { text: "not just an answer.", size: 48, color: "0xFFE1A8" },
    ],
    {
      name: STORY_WINDOWS[6].name,
      size: 48,
      color: "0xFFF7EA",
      font,
      start: STORY_WINDOWS[6].start,
      end: STORY_WINDOWS[6].end,
      top: 300,
      pitch: 68,
      padY: 24,
    },
  );

  const cta = panel(["Join the waitlist - link in bio"], {
    name: CTA_WINDOW.name,
    size: 40,
    color: "0x20160A",
    font,
    start: CTA_WINDOW.start,
    end: CTA_WINDOW.end,
    bottom: CTA_BOTTOM,
    bg: "0xF2A03C@0.96",
    padX: 46,
    padY: 26,
  });

  // ---- brand chip (top right) + the owl mark, keyed out of logo.PNG ----
  const chip =
    `drawbox=x=${CHIP.x}:y=${CHIP.y}:w=${CHIP.w}:h=${CHIP.h}:color=${LABEL_BG}:t=fill:enable='between(t,0.5,${TOTAL})',` +
    `drawtext=fontfile='${font}':text='AmigosNest':fontsize=32:fontcolor=white` +
    `:x=${CHIP.x + CHIP.w - 26}-text_w:y=${CHIP.y + 34}:enable='between(t,0.5,${TOTAL})'`;
  const timelineOverlays = [...captions, ...labels, tagline, cta, chip].join(",");
  assertNoTextCollision(BLOCKS);

  // ---- audio: measured trims + level match + cue, over the generated bed ----
  const audioParts = DIALOGUE.map((d, i) => {
    const ms = Math.round(d.cue * 1000);
    return (
      `[${BEATS.length + i}:a]atrim=start=${d.trim[0]}:end=${d.trim[1]},asetpts=N/SR/TB,` +
      `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `volume=${d.gainDb}dB,adelay=${ms}|${ms}[dl${i}]`
    );
  });
  audioParts.push(`[${musicIdx}:a]volume=${MUSIC_LEVEL}[bed]`);
  audioParts.push(
    `[${DIALOGUE.map((_, i) => "dl" + i).join("][")}][bed]amix=inputs=${DIALOGUE.length + 1}` +
      `:duration=longest:normalize=0,alimiter=limit=0.95,atrim=0:${TOTAL},asetpts=N/SR/TB[aout]`,
  );

  // ---- one filter graph, one encode ----
  const filterParts = [...branches, ...dissolve, `[tl]${timelineOverlays},format=yuv420p[dc]`];
  if (logoPath) {
    filterParts.push(
      `[${logoIdx}:v]colorkey=0xFFFFFF:0.16:0.06,split=2[owla][owlb];` +
        `[owla]scale=-1:46:flags=lanczos[owlchip];` +
        `[owlb]scale=-1:${OWL_HEIGHT}:flags=lanczos[owlbig]`,
    );
    filterParts.push(
      `[dc][owlchip]overlay=x=${CHIP.x + 22}:y=${CHIP.y + 28}:enable='between(t,0.5,${TOTAL})'[vo]` +
        `;[vo][owlbig]overlay=x=(W-w)/2:y=${OWL_Y}:enable='between(t,${CTA_WINDOW.start},${CTA_WINDOW.end})',format=yuv420p[v]`,
    );
  } else {
    filterParts.push("[dc]format=yuv420p[v]");
  }
  filterParts.push(...audioParts);

  const encodeStart = Date.now();
  await runFfmpeg(
    ffmpeg,
    [
      ...inputs,
      "-filter_threads", String(FILTER_THREADS),
      "-filter_complex", filterParts.join(";"),
      "-map", "[v]", "-map", "[aout]",
      "-r", String(FPS), "-t", String(TOTAL),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", String(SAMPLE_RATE),
      "-movflags", "+faststart", "-shortest", OUT_FILE,
    ],
    "ffmpeg-err.txt",
  );

  const { size } = await stat(OUT_FILE);
  const secs = (Date.now() - started) / 1000;
  console.log(
    "Done: " + (size / 1024 / 1024).toFixed(1) + " MB, " + W + "x" + H + ", " + TOTAL.toFixed(1) + "s, " +
      BEATS.length + " beats in 1 encode\n" +
      "  encode " + ((Date.now() - encodeStart) / 1000).toFixed(1) + "s, total " +
      Math.floor(secs / 60) + "m" + String(Math.round(secs % 60)).padStart(2, "0") + "s, " +
      (TOTAL / secs).toFixed(1) + "x realtime\n" +
      "  " + path.relative(root, OUT_FILE).replace(/\\/g, "/"),
  );
  if (logoPath) {
    console.log("  owl mark keyed from " + path.relative(root, logoPath).replace(/\\/g, "/") +
      " (chip + closing), dialogue cued to " + DIALOGUE.map((d) => d.cue.toFixed(1)).join("/") + "s");
  }
  try { await rm(WORK, { recursive: true, force: true }); } catch { /* keep output even if cleanup fails */ }
}

main().catch((e) => {
  console.error(e.stack ?? e.message ?? e);
  process.exitCode = 1;
});

