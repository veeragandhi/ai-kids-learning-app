// Frame-level analysis of a raw recording: per-frame change magnitude, black-frame
// detection and static-run detection. Used to find dead time and verify trims.
import { execFileSync } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || (await import("ffmpeg-static")).default;
const FPS = 5;
const SIZE = 16;

export function analyse(file) {
  const raw = execFileSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-vf", `fps=${FPS},scale=${SIZE}:${SIZE}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1024 * 1024 * 512 },
  );
  const frameBytes = SIZE * SIZE * 3;
  const frames = [];
  for (let i = 0; i + frameBytes <= raw.length; i += frameBytes) {
    let r = 0, g = 0, b = 0;
    for (let p = 0; p < frameBytes; p += 3) {
      r += raw[i + p];
      g += raw[i + p + 1];
      b += raw[i + p + 2];
    }
    const n = SIZE * SIZE;
    frames.push({ r: r / n, g: g / n, b: b / n });
  }
  const diffs = frames.map((f, i) => {
    if (i === 0) return 0;
    const p = frames[i - 1];
    return (Math.abs(f.r - p.r) + Math.abs(f.g - p.g) + Math.abs(f.b - p.b)) / 3;
  });
  return { frames, diffs };
}

export function report(file, opts = {}) {
  const { frames, diffs } = analyse(file);
  const threshold = opts.threshold ?? 6;
  const staticRun = opts.staticRun ?? 8; // frames (<= ~1.6s) considered static
  const events = [];
  let runStart = 0;
  for (let i = 1; i <= diffs.length; i++) {
    const d = i < diffs.length ? diffs[i] : Infinity;
    if (d > threshold) {
      if (i - runStart >= staticRun) {
        events.push({ type: "static", from: runStart / FPS, to: i / FPS, secs: (i - runStart) / FPS });
      }
      events.push({ type: "change", at: i / FPS, mag: +d.toFixed(1) });
      runStart = i;
    }
  }
  const black = frames
    .map((f, i) => ({ i, lum: (0.299 * f.r + 0.587 * f.g + 0.114 * f.b) }))
    .filter((f) => f.lum < 6)
    .map((f) => f.i / FPS);
  return { count: frames.length, duration: frames.length / FPS, events, black };
}

if (process.argv[2]) {
  for (const f of process.argv.slice(2)) {
    const r = report(f);
    console.log(`\n=== ${f} (${r.duration.toFixed(2)}s, ${r.count} frames) ===`);
    console.log("black frames:", r.black.length ? r.black.join(",") : "none");
    for (const e of r.events) {
      console.log(
        e.type === "change"
          ? `  change @${e.at.toFixed(2)}s mag=${e.mag}`
          : `  STATIC  ${e.from.toFixed(2)}s -> ${e.to.toFixed(2)}s (${e.secs.toFixed(2)}s)`,
      );
    }
  }
}
