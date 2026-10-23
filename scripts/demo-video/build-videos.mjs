import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { resolveFfmpeg } from "../convert-to-mp4.mjs";
import { report } from "./frames.mjs";

const FFMPEG = await resolveFfmpeg();
const ROOT = process.env.DEMO_WORK_DIR || path.join(os.tmpdir(), "amigosnest-demos");
const RAW = path.join(ROOT, "raw");
const OUT = path.join(ROOT, "out");
const DEST = process.env.DEMO_DEST || path.join(process.cwd(), "artifacts", "amigosnest-demos");
const FONT = process.env.DEMO_FONT || "/System/Library/Fonts/Supplemental/Arial Bold.ttf";

fs.mkdirSync(DEST, { recursive: true });

function marks(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(OUT, `marks-${name}.json`), "utf8"));
  const t0 = raw[0].t;
  return raw.map((m) => ({ label: m.label, t: (m.t - t0) / 1000 }));
}

function probe(file) {
  let info = "";
  try {
    info = execFileSync(FFMPEG, ["-hide_banner", "-i", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    info = `${err.stdout || ""}${err.stderr || ""}`;
  }
  const m = info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!m) throw new Error(`no duration for ${file}`);
  return { info, duration: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
}

function dur(file) {
  return probe(file).duration;
}

function at(list, label) {
  const hit = list.find((m) => m.label === label);
  if (!hit) throw new Error(`missing mark ${label}`);
  return hit.t;
}

/**
 * Trim plan per demo. Segments are [start, end] in raw-video seconds.
 * The only cuts are the real model waits (lesson generation, quiz build);
 * every user-visible step is recorded end to end.
 */
function plan() {
  const a = marks("a");
  const b = marks("b");
  const c = marks("c");
  const d = marks("d");

  const aEnd = at(a, "lesson-back-to-top") + 1.6;
  const bEnd = at(b, "child-library") + 3.2;
  const cGenStart = at(c, "generating");
  const cGenEnd = at(c, "lesson-generated");
  const dEnd = at(d, "review") + 2.2;

  return [
    {
      key: "a",
      src: "a-overview.webm",
      out: "amigosnest-overview.mp4",
      label: "A - Kids learning hub",
      segments: [[0, aEnd]],
      posterLabel: "home-topics",
    },
    {
      key: "b",
      src: "b-parent-dashboard.webm",
      out: "amigosnest-parent-dashboard.mp4",
      label: "B - Parent dashboard",
      segments: [[0, bEnd]],
      posterLabel: "dashboard",
    },
    {
      key: "c",
      src: "c-lesson-workflow.webm",
      out: "amigosnest-lesson-workflow.mp4",
      label: "C - Upload to AI lesson",
      // keep 2.5s of the real generation screen, drop the dead wait
      segments: [
        [0, cGenStart + 2.5],
        [cGenEnd, dur(path.join(RAW, "c-lesson-workflow.webm"))],
      ],
      posterLabel: "saved-lesson",
    },
    {
      key: "d",
      src: "d-guided-learning.webm",
      out: "amigosnest-guided-learning.mp4",
      label: "D - Guided thinking on the lesson",
      segments: [[0, dEnd]],
      posterLabel: "explanation",
    },
  ];
}

/** Map a raw timestamp to the trimmed timeline. */
function mapTime(segments, rawT) {
  let acc = 0;
  for (const [s, e] of segments) {
    if (rawT >= s && rawT <= e) return acc + (rawT - s);
    if (rawT > e) acc += e - s;
  }
  return acc;
}

function build(spec) {
  const src = path.join(RAW, spec.src);
  const dst = path.join(DEST, spec.out);
  const parts = [];
  spec.segments.forEach(([s, e], i) => {
    parts.push(`[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  });
  const concat =
    spec.segments.length > 1
      ? `${spec.segments.map((_, i) => `[v${i}]`).join("")}concat=n=${spec.segments.length}:v=1:a=0[vc];`
      : "[v0]null[vc];";
  const label = spec.label.replace(/'/g, "");
  const chain = [
    "[vc]fps=30",
    "scale=1440:900:flags=lanczos",
    "setsar=1",
    "format=yuv420p",
    `drawtext=fontfile='${FONT}':text='${label}':fontsize=21:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=12:x=28:y=h-58[vout]`,
  ].join(",");

  execFileSync(
    FFMPEG,
    [
      "-y",
      "-i",
      src,
      "-filter_complex",
      `${parts.join(";")};${concat}${chain}`,
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "20",
      "-profile:v",
      "high",
      "-level",
      "4.0",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      dst,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return dst;
}

function poster(spec, marksList) {
  const src = path.join(DEST, spec.out);
  const rawT = at(marksList, spec.posterLabel);
  const t = mapTime(spec.segments, rawT);
  const dst = path.join(DEST, spec.out.replace(/\.mp4$/, "-poster.jpg"));
  execFileSync(
    FFMPEG,
    ["-y", "-ss", t.toFixed(2), "-i", src, "-frames:v", "1", "-q:v", "3", dst],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return dst;
}

const specs = plan();
const qa = [];
for (const spec of specs) {
  const marksList = marks(spec.key);
  const out = build(spec);
  const p = poster(spec, marksList);
  const { info, duration: d } = probe(out);
  const stream = info.match(/Stream #0:0.*?: Video: (\w+).*?, (\d+)x(\d+)[^,]*,.*?(\d+) fps/);
  const hasAudio = /Audio:/.test(info);
  const stat = report(out, { threshold: 6, staticRun: 12 });
  qa.push({
    file: spec.out,
    label: spec.label,
    durationSec: Number(d.toFixed(2)),
    width: stream ? Number(stream[2]) : null,
    height: stream ? Number(stream[3]) : null,
    fps: stream ? Number(stream[4]) : null,
    codec: stream ? stream[1] : null,
    pixFmt: /yuv420p/.test(info) ? "yuv420p" : "unknown",
    hasAudio,
    bytes: fs.statSync(out).size,
    poster: path.basename(p),
    blackFrames: stat.black.length,
    segments: spec.segments.map(([s, e]) => [Number(s.toFixed(2)), Number(e.toFixed(2))]),
  });
  console.log(`built ${spec.out} (${d.toFixed(2)}s)`);
}

fs.writeFileSync(path.join(DEST, "qa-report.json"), JSON.stringify(qa, null, 2));
console.log(JSON.stringify(qa, null, 2));
