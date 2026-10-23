import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveFfmpeg } from "../convert-to-mp4.mjs";
import { report } from "./frames.mjs";

const DEST = process.env.DEMO_DEST || path.join(process.cwd(), "artifacts", "amigosnest-demos");
const FONT = process.env.DEMO_FONT || "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const FFMPEG = await resolveFfmpeg();

const clips = [
  { file: "amigosnest-parent-dashboard.mp4" },
  { file: "amigosnest-lesson-workflow.mp4" },
  { file: "amigosnest-guided-learning.mp4" },
  { file: "amigosnest-quiz.mp4" },
  { file: "amigosnest-explore.mp4" },
];

function duration(file) {
  let info = "";
  try {
    info = execFileSync(FFMPEG, ["-hide_banner", "-i", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    info = `${error.stdout || ""}${error.stderr || ""}`;
  }
  const match = info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!match) throw new Error(`Unable to read video duration: ${file}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

const inputs = clips.map((clip) => clip.input || path.join(DEST, clip.file));
for (const file of inputs) {
  if (!fs.existsSync(file)) throw new Error(`Required demo clip is missing: ${file}`);
}

const durations = inputs.map(duration);
const filters = clips.map((clip, index) => {
  const steps = [
    `[${index}:v]fps=30`,
    "scale=1440:900:flags=lanczos",
    "setsar=1",
    "format=yuv420p",
  ];
  if (clip.label) {
    steps.push(
      `drawtext=fontfile='${FONT}':text='${clip.label}':fontsize=21:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=12:x=28:y=h-58`,
    );
  }
  steps.push(`setpts=PTS-STARTPTS[v${index}]`);
  return steps.join(",");
});
const concat = `${clips.map((_, index) => `[v${index}]`).join("")}concat=n=${clips.length}:v=1:a=0[vout]`;
const output = path.join(DEST, "amigosnest-complete-walkthrough.mp4");
const poster = path.join(DEST, "amigosnest-complete-walkthrough-poster.jpg");
fs.mkdirSync(DEST, { recursive: true });

execFileSync(
  FFMPEG,
  [
    "-y",
    ...inputs.flatMap((file) => ["-i", file]),
    "-filter_complex",
    `${filters.join(";")};${concat}`,
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "21",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const posterTime = Math.min(7.5, durations[0] - 0.5);
execFileSync(
  FFMPEG,
  ["-y", "-ss", posterTime.toFixed(2), "-i", output, "-frames:v", "1", "-q:v", "3", poster],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const qa = report(output, { threshold: 6, staticRun: 12 });
const summary = {
  video: output,
  poster,
  clips: clips.map((clip, index) => ({
    source: clip.file,
    durationSeconds: Number(durations[index].toFixed(2)),
  })),
  durationSeconds: Number(durations.reduce((sum, value) => sum + value, 0).toFixed(2)),
  bytes: fs.statSync(output).size,
  blackFrames: qa.black.length,
};
console.log(JSON.stringify(summary, null, 2));
