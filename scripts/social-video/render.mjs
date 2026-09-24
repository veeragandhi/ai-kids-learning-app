/**
 * Renders the AmigosNest social cut end to end, entirely offline:
 *
 *   1. voiceover   Windows SAPI (PowerShell) -> one WAV per spoken line
 *   2. timeline    measured voice line lengths -> cue list (scripts/social-video/direction.mjs)
 *   3. music/SFX   synthesised in Node (scripts/social-video/audio.mjs)
 *   4. picture     Playwright records the SVG stage at 1080x1920
 *   5. master      ffmpeg trims the black pre-roll, mixes audio, encodes H.264 MP4
 *
 * Usage:
 *   npm run video:social                 full render
 *   npm run video:social -- --stills     also write one PNG per scene (review / carousel)
 *   npm run video:social -- --timeline-only   rebuild the cue list + WAVs, no recording
 *   npm run video:social -- --reuse-voiceover keep existing WAVs (edit only the animation)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFfmpeg } from "../convert-to-mp4.mjs";
import { HEIGHT, SCENES, VOICES, WIDTH, allBeats } from "./lines.mjs";
import { buildTimeline } from "./direction.mjs";
import {
  SAMPLE_RATE,
  chime,
  musicBed,
  tick,
  wavDurationSeconds,
  whoosh,
  writeMonoWav,
  writeStereoWav,
} from "./audio.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");

export const STAGE_PATH = path.join(projectRoot, "marketing/social-video/amigosnest-35s.html");
export const OUTPUT_DIR = path.join(projectRoot, "artifacts/social-video");
export const WORK_DIR = path.join(OUTPUT_DIR, "work");
export const VOICE_DIR = path.join(WORK_DIR, "voice");
export const VIDEO_NAME = "AmigosNest-thinking-companion-35s-9x16.mp4";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);

/** Runs ffmpeg and returns stderr (where ffmpeg reports everything useful). */
async function runFfmpeg(ffmpegArgs) {
  const ffmpeg = await resolveFfmpeg();
  try {
    const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", ...ffmpegArgs], {
      maxBuffer: 1024 * 1024 * 64,
    });
    return stderr;
  } catch (error) {
    const stderr = error.stderr ?? "";
    throw new Error(`ffmpeg ${ffmpegArgs.slice(0, 6).join(" ")}… failed:\n${stderr.slice(-2000)}`);
  }
}

/**
 * Reads a PCM WAV and reports its duration plus loudness so the mix can be
 * normalised without listening to it.
 */
async function analyseWav(filePath) {
  const buf = await readFile(filePath);
  let offset = 12;
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
  let bits = 16;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 8 + 2);
      sampleRate = buf.readUInt32LE(offset + 8 + 4);
      bits = buf.readUInt16LE(offset + 8 + 14) || 16;
    } else if (id === "data") {
      dataStart = offset + 8;
      dataSize = Math.min(size, buf.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0 || bits !== 16) {
    throw new Error(`Unsupported WAV (need 16-bit PCM): ${filePath}`);
  }
  let sumSquares = 0;
  let peak = 0;
  const count = Math.floor(dataSize / 2);
  for (let i = 0; i < count; i += 1) {
    const v = buf.readInt16LE(dataStart + i * 2) / 32768;
    sumSquares += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  return {
    seconds: dataSize / (sampleRate * channels * 2),
    rms: Math.sqrt(sumSquares / Math.max(1, count)),
    peak,
  };
}

function stereo(mono) {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) {
    out[i * 2] = mono[i];
    out[i * 2 + 1] = mono[i];
  }
  return out;
}

/** Renders every spoken line with the local SAPI voices and shapes the pitch. */
async function buildVoiceovers() {
  const rawDir = path.join(WORK_DIR, "voice-raw");
  const textDir = path.join(WORK_DIR, "voice-text");
  await Promise.all([
    mkdir(rawDir, { recursive: true }),
    mkdir(textDir, { recursive: true }),
    mkdir(VOICE_DIR, { recursive: true }),
  ]);

  const voiceDurations = {};
  const files = [];

  for (const beat of allBeats()) {
    const profile = VOICES[beat.speaker] ?? VOICES.narrator;
    const textPath = path.join(textDir, `${beat.fileName}.txt`);
    const rawPath = path.join(rawDir, beat.fileName);
    const outPath = path.join(VOICE_DIR, beat.fileName);

    if (!hasFlag("--reuse-voiceover")) {
      await writeFile(textPath, beat.text, "utf8");
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(here, "tts-voiceover.ps1"),
          "-TextFile",
          textPath,
          "-Out",
          rawPath,
          "-Voice",
          profile.sapiVoice,
          "-Rate",
          String(profile.rate),
        ],
        { maxBuffer: 1024 * 1024 * 8 },
      );
    }

    const raw = await analyseWav(rawPath);
    const gain = Math.max(0.6, Math.min(3.2, 0.22 / Math.max(0.01, raw.rms)));
    const ratio = profile.pitch;
    await runFfmpeg([
      "-y",
      "-i",
      rawPath,
      "-af",
      [
        `aresample=${SAMPLE_RATE}`,
        `asetrate=${Math.round(SAMPLE_RATE * ratio)}`,
        `aresample=${SAMPLE_RATE}`,
        `atempo=${(1 / ratio).toFixed(4)}`,
        "highpass=f=85",
        `volume=${gain.toFixed(2)}`,
      ].join(","),
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "2",
      outPath,
    ]);

    // Small tail so a short final word never sits on the scene cut.
    const shaped = await analyseWav(outPath);
    voiceDurations[beat.fileName] = Math.round((shaped.seconds + 0.12) * 1000) / 1000;
    files.push({ ...beat, path: outPath });
  }

  return { voiceDurations, files };
}

/** Music bed + the three small sound effects used by the direction cues. */
async function buildMusicAndSfx(durationSeconds) {
  const musicPath = path.join(WORK_DIR, "music.wav");
  const { left, right } = musicBed(durationSeconds + 0.6);
  const interleaved = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i += 1) {
    interleaved[i * 2] = left[i];
    interleaved[i * 2 + 1] = right[i];
  }
  await writeStereoWav(musicPath, interleaved);

  const sfx = {
    chime: { path: path.join(WORK_DIR, "sfx-chime.wav"), volume: 0.42 },
    whoosh: { path: path.join(WORK_DIR, "sfx-whoosh.wav"), volume: 0.34 },
    tick: { path: path.join(WORK_DIR, "sfx-tick.wav"), volume: 0.4 },
  };
  await writeStereoWav(sfx.chime.path, stereo(chime()));
  await writeStereoWav(sfx.whoosh.path, stereo(whoosh()));
  await writeStereoWav(sfx.tick.path, stereo(tick()));
  return { musicPath, sfx };
}

/** Records the SVG stage at 1080x1920 and returns the raw .webm path. */
export async function recordStage(timeline, { stills = false } = {}) {
  const { chromium } = await import("playwright");
  const { pathToFileURL } = await import("node:url");
  const url = pathToFileURL(STAGE_PATH).href;
  const initScript = { content: `window.__AMIGOS_TIMELINE__ = ${JSON.stringify(timeline)};` };

  const browser = await chromium.launch();
  try {
    if (stills) {
      // Separate, un-recorded context so review stills never land in the video.
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.addInitScript(initScript);
      await page.goto(url, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__amigos?.ready));
      const stillDir = path.join(OUTPUT_DIR, "stills");
      await mkdir(stillDir, { recursive: true });
      for (const scene of timeline.scenes) {
        const meta = SCENES.find((s) => s.id === scene.id);
        const at = scene.start + scene.duration * 0.55;
        await page.evaluate((t) => window.__amigos.seek(t, true), at);
        await page.waitForTimeout(220);
        await page.screenshot({ path: path.join(stillDir, `${scene.id}-${meta?.slug ?? "scene"}.png`) });
      }
      await context.close();
      console.log(`Scene stills -> ${path.join(stillDir, "*.png")}`);
    }

    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      recordVideo: { dir: WORK_DIR, size: { width: WIDTH, height: HEIGHT } },
    });
    const page = await context.newPage();
    await page.addInitScript(initScript);
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__amigos?.ready));
    await page.evaluate(() => window.__amigos.play());
    await page.waitForFunction(() => window.__AMIGOS_DONE__ === true, undefined, {
      timeout: 120000,
      polling: 250,
    });
    const videoPath = await page.video().path();
    await context.close();
    return videoPath;
  } finally {
    await browser.close();
  }
}

/**
 * The recording always opens on the stage's black pre-roll. ffmpeg tells us
 * where that black ends, which is frame 0 of the animation — that offset is how
 * the audio mix stays in sync with the picture.
 */
export async function detectBlackEnd(videoPath) {
  const stderr = await runFfmpeg([
    "-i",
    videoPath,
    "-vf",
    "blackdetect=d=0.05:pix_th=0.08",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const matches = [...stderr.matchAll(/black_end:([0-9.]+)/g)].map((m) => Number(m[1]));
  if (!matches.length) return 0;
  return matches[matches.length - 1];
}

let filterCache = null;
/** ffmpeg-static is a slim build; only use filters it actually ships. */
async function hasFilter(name) {
  if (!filterCache) {
    const stderr = await runFfmpeg(["-filters"]);
    filterCache = stderr;
  }
  return new RegExp(`\\s${name}\\s`).test(filterCache);
}

/** Trims the pre-roll, mixes voice + music + SFX and writes the H.264 master. */
export async function mixAndEncode({ videoPath, trimStart, timeline, voiceFiles, musicPath, sfx, outPath }) {
  const ffmpeg = await resolveFfmpeg();
  const target = timeline.target;
  const inputArgs = ["-ss", trimStart.toFixed(3), "-i", videoPath, "-i", musicPath];
  const parts = [];
  const mixLabels = [];
  let inputIndex = 2;

  parts.push(
    `[1:a]volume=0.17,atrim=end=${target},asetpts=PTS-STARTPTS,afade=t=out:st=${(target - 2.4).toFixed(2)}:d=2.4[m]`,
  );
  mixLabels.push("[m]");

  // One input per spoken line, delayed to its cue time so picture and voice agree.
  const captionCues = timeline.cues.filter((c) => c.kind === "caption");
  captionCues.forEach((cue, i) => {
    const file = voiceFiles[i];
    if (!file) return;
    inputArgs.push("-i", file.path);
    parts.push(`[${inputIndex}:a]adelay=${Math.round(cue.at * 1000)}:all=1[vo${i}]`);
    mixLabels.push(`[vo${i}]`);
    inputIndex += 1;
  });

  // One input per SFX type, split when the same effect is used more than once.
  const byType = new Map();
  for (const event of timeline.events) {
    if (!byType.has(event.type)) byType.set(event.type, []);
    byType.get(event.type).push(event.at);
  }
  for (const [type, times] of byType) {
    const asset = sfx[type];
    if (!asset) continue;
    inputArgs.push("-i", asset.path);
    const source = `[${inputIndex}:a]`;
    if (times.length > 1) {
      parts.push(`${source}asplit=${times.length}${times.map((_, i) => `[${type}${i}]`).join("")}`);
    }
    times.forEach((at, i) => {
      const from = times.length > 1 ? `[${type}${i}]` : source;
      parts.push(`${from}adelay=${Math.round(at * 1000)}:all=1,volume=${asset.volume}[mix${type}${i}]`);
      mixLabels.push(`[mix${type}${i}]`);
    });
    inputIndex += 1;
  }

  parts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[sum]`);
  parts.push(
    (await hasFilter("alimiter"))
      ? "[sum]alimiter=limit=0.95:attack=5:release=60[a]"
      : "[sum]volume=0.9[a]",
  );
  parts.push(
    `[0:v]trim=end=${target},setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=${timeline.fps},setsar=1[v]`,
  );

  await execFileAsync(
    ffmpeg,
    [
      "-y",
      ...inputArgs,
      "-filter_complex",
      parts.join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(timeline.fps),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-t",
      String(target),
      outPath,
    ],
    { maxBuffer: 1024 * 1024 * 64 },
  );

  return outPath;
}

/** Reads the container duration, since ffmpeg-static ships no ffprobe. */
export async function probeDuration(filePath) {
  const ffmpeg = await resolveFfmpeg();
  const parse = (text) => {
    const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text ?? "");
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  };
  try {
    const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", filePath]);
    return parse(stderr);
  } catch (error) {
    return parse(error.stderr);
  }
}

const fmt = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};

async function main() {
  const startedAt = Date.now();
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  console.log("AmigosNest social cut — 9:16 vertical, fully offline render");
  console.log(`stage : ${path.relative(projectRoot, STAGE_PATH)}`);

  const { voiceDurations, files: voiceFiles } = await buildVoiceovers();
  const timeline = buildTimeline(voiceDurations);
  await writeFile(path.join(OUTPUT_DIR, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(projectRoot, "marketing/social-video/timeline.js"),
    "// GENERATED by scripts/social-video/render.mjs — do not edit by hand.\n" +
      "// Regenerate with:  npm run video:social:timeline\n" +
      `window.__AMIGOS_TIMELINE__ = ${JSON.stringify(timeline)};\n`,
    "utf8",
  );

  console.log("\nscene map");
  for (const scene of timeline.scenes) {
    const meta = SCENES.find((s) => s.id === scene.id);
    console.log(
      `  ${scene.id}  ${fmt(scene.start)} -> ${fmt(scene.start + scene.duration)}   ${meta?.title ?? ""}`,
    );
  }
  console.log(`  total ${fmt(timeline.target)} · ${allBeats().length} spoken lines`);
  for (const warning of timeline.warnings) console.log(`  ! ${warning}`);

  if (hasFlag("--timeline-only")) {
    console.log("\ntimeline + voiceover rebuilt; recording skipped (--timeline-only)");
    return;
  }

  const { musicPath, sfx } = await buildMusicAndSfx(timeline.target);

  console.log("\nrecording the stage (1080x1920, 30fps target)…");
  const videoPath = await recordStage(timeline, { stills: hasFlag("--stills") });
  const trimStart = await detectBlackEnd(videoPath);
  console.log(`  black pre-roll ends at ${trimStart.toFixed(2)}s — audio offset uses the same value`);

  const outPath = path.join(OUTPUT_DIR, VIDEO_NAME);
  console.log("mixing voice + music + sfx, encoding H.264…");
  await mixAndEncode({ videoPath, trimStart, timeline, voiceFiles, musicPath, sfx, outPath });
  await rm(videoPath, { force: true });

  const seconds = await probeDuration(outPath);
  const { size } = await stat(outPath);
  console.log(`\n${path.relative(projectRoot, outPath)}`);
  console.log(
    `  ${fmt(seconds ?? timeline.target)} · 1080x1920 (9:16) · 30fps · ${(size / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(`  rendered in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
}

main().catch((error) => {
  console.error(`\nrender failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
