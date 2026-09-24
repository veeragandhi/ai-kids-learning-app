/**
 * Deterministic, offline audio helpers for the social video.
 *
 * Everything here is plain Node maths -> 16-bit PCM WAV. No cloud TTS/stock
 * music, no new dependencies (the project already ships ffmpeg-static for the
 * final mux). Files are written to the render's working folder so a re-render
 * with the same inputs produces byte-identical audio.
 */

import { writeFile } from "node:fs/promises";

export const SAMPLE_RATE = 44100;

/** Small deterministic PRNG (mulberry32) — keeps noise-based SFX reproducible. */
export function makeRandom(seed = 20240921) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reads a PCM WAV header. Used instead of ffprobe (ffmpeg-static ships no probe). */
export async function wavDurationSeconds(filePath) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(filePath);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`Not a RIFF/WAV file: ${filePath}`);
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      byteRate = buf.readUInt32LE(offset + 8 + 8);
    } else if (chunkId === "data") {
      dataSize = Math.min(chunkSize, buf.length - (offset + 8));
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataSize) {
    throw new Error(`Unreadable WAV header: ${filePath}`);
  }
  return dataSize / byteRate;
}

/** Writes interleaved [-1..1] mono samples as a 16-bit PCM WAV. */
export async function writeMonoWav(filePath, samples, sampleRate = SAMPLE_RATE) {
  await writeFile(filePath, encodeWav(samples, 1, sampleRate));
}

/** Writes interleaved [-1..1] stereo samples (L,R,L,R…) as a 16-bit PCM WAV. */
export async function writeStereoWav(filePath, samples, sampleRate = SAMPLE_RATE) {
  await writeFile(filePath, encodeWav(samples, 2, sampleRate));
}

function encodeWav(samples, channels, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

// ─── Music bed ────────────────────────────────────────────────────────────────

/** Warm, slow chord loop (I–V–vi–IV in C), felt-piano pad + soft arpeggio. */
const CHORDS = [
  [261.63, 329.63, 392.0], // C
  [196.0, 246.94, 392.0], // G
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 349.23], // F
];

/**
 * Gentle underscore: slow triads, a light arpeggio on top, soft lowpass and
 * 2s fades. Quiet on purpose so dialogue always sits on top.
 */
export function musicBed(durationSeconds, { seed = 7 } = {}) {
  const total = Math.round(durationSeconds * SAMPLE_RATE);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const chordSeconds = 4.0;
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    const chordIndex = Math.floor(t / chordSeconds) % CHORDS.length;
    const chord = CHORDS[chordIndex];
    const local = (t % chordSeconds) / chordSeconds;

    // Pad: each triad tone with a touch of its fifth above for warmth.
    let pad = 0;
    for (let v = 0; v < chord.length; v += 1) {
      const f = chord[v];
      const detune = 1 + (v - 1) * 0.0015;
      pad += 0.30 * Math.sin(2 * Math.PI * f * detune * t);
      pad += 0.10 * Math.sin(2 * Math.PI * f * 2 * t);
    }
    // Slow breathing movement so the pad never feels static.
    const swell = 0.72 + 0.28 * Math.sin(2 * Math.PI * (0.055 + 0.01 * chordIndex) * t);
    // Chord cross-fade so transitions are not audible.
    const edge = Math.min(1, local / 0.12, (1 - local) / 0.12);

    // Arpeggio: a soft bell on the bar's start, decaying.
    const beat = t % 1.0;
    const noteF = chord[(Math.floor(t) % chord.length) + 0] * 2;
    const arp = 0.10 * Math.exp(-3.2 * beat) * Math.sin(2 * Math.PI * noteF * t);

    const mono = (pad * swell * edge + arp) * 0.16;
    const width = 0.006 * Math.sin(2 * Math.PI * 0.12 * t);
    left[i] = mono * (1 + width);
    right[i] = mono * (1 - width);
  }

  applyFades(left, right, 2.0, 2.6);
  return { left, right };
}

// ─── Sound effects ────────────────────────────────────────────────────────────

/** Two-note bell for the "aha" moment. Returns mono samples. */
export function chime({ base = 587.33, seconds = 2.4 } = {}) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(total);
  const partials = [1, 2.01, 2.98, 4.17];
  const weights = [1, 0.42, 0.22, 0.1];
  const secondAt = Math.round(0.16 * SAMPLE_RATE);
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (let p = 0; p < partials.length; p += 1) {
      v += weights[p] * Math.exp(-2.6 * t) * Math.sin(2 * Math.PI * base * partials[p] * t);
    }
    if (i >= secondAt) {
      const t2 = (i - secondAt) / SAMPLE_RATE;
      for (let p = 0; p < partials.length; p += 1) {
        v +=
          0.7 *
          weights[p] *
          Math.exp(-2.9 * t2) *
          Math.sin(2 * Math.PI * base * 1.5 * partials[p] * t2);
      }
    }
    out[i] = v * 0.24;
  }
  return out;
}

/** Soft airy transition whoosh (filtered noise sweep). */
export function whoosh({ seconds = 0.9, seed = 11 } = {}) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(total);
  const random = makeRandom(seed);
  let lp = 0;
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    const progress = t / seconds;
    const cutoff = 0.02 + 0.5 * Math.sin(Math.PI * progress); // opens then closes
    const noise = random() * 2 - 1;
    lp += cutoff * (noise - lp);
    const env = Math.sin(Math.PI * progress) ** 2;
    out[i] = lp * env * 0.18;
  }
  return out;
}

/** Tiny soft tick for keyboard typing / UI blips. */
export function tick({ freq = 1500, seconds = 0.09 } = {}) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] = Math.exp(-30 * t) * Math.sin(2 * Math.PI * freq * t) * 0.2;
  }
  return out;
}

function applyFades(left, right, inSeconds, outSeconds) {
  const inN = Math.round(inSeconds * SAMPLE_RATE);
  const outN = Math.round(outSeconds * SAMPLE_RATE);
  const total = left.length;
  for (let i = 0; i < inN && i < total; i += 1) {
    const g = i / inN;
    left[i] *= g;
    right[i] *= g;
  }
  for (let i = 0; i < outN && i < total; i += 1) {
    const g = i / outN;
    left[total - 1 - i] *= g;
    right[total - 1 - i] *= g;
  }
}
