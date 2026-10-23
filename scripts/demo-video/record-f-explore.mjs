import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BASE, CHILD_ID, ensureDirs, finish, launch, makeMarker, OUT_DIR, PROFILE_DIR, seedLearnerScript,
} from "./rec-common.mjs";
import { resolveFfmpeg } from "../convert-to-mp4.mjs";
import { report } from "./frames.mjs";

ensureDirs();
const marks = [];
const mark = (label) => makeMarker(null, label, marks);
const pauses = { screen: 1800, result: 2500, generation: 2.5 };
const destDir = process.env.DEMO_DEST || path.join(process.cwd(), "artifacts", "amigosnest-demos");
const ffmpeg = await resolveFfmpeg();
const font = process.env.DEMO_FONT || "/System/Library/Fonts/Supplemental/Arial Bold.ttf";

async function submitAsk(page, buttonName, expectedType, waitFor) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/ask") && response.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.getByRole("button", { name: buttonName }).click();
  const response = await responsePromise;
  const data = await response.json();
  if (!response.ok() || data.type !== expectedType) {
    throw new Error(`Explore ${expectedType} request failed: ${data.error || `HTTP ${response.status()}`}`);
  }
  await page.getByText(waitFor).waitFor({ timeout: 300000 });
}

function markTime(label) {
  const item = marks.find((entry) => entry.label === label);
  if (!item) throw new Error(`Missing marker ${label}`);
  return (item.t - marks[0].t) / 1000;
}

function probe(file) {
  let info = "";
  try {
    info = execFileSync(ffmpeg, ["-hide_banner", "-i", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    info = `${error.stdout || ""}${error.stderr || ""}`;
  }
  const match = info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!match) throw new Error(`Could not read video duration for ${file}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function mapTime(segments, rawTime) {
  let elapsed = 0;
  for (const [start, end] of segments) {
    if (rawTime >= start && rawTime <= end) return elapsed + rawTime - start;
    if (rawTime > end) elapsed += end - start;
  }
  throw new Error(`Poster timestamp ${rawTime.toFixed(2)} is outside the retained video segments`);
}

async function exportVideo(raw) {
  const duration = probe(raw);
  const last = marks.at(-1);
  const rawEnd = (last.t - marks[0].t) / 1000;
  const endAfterWait = (name) =>
    Math.min(markTime(`${name}-generating`) + pauses.generation, markTime(`${name}-loaded`));
  const segments = [
    [0, endAfterWait("plants-question")],
    [markTime("plants-question-loaded"), endAfterWait("plants-answer")],
    [markTime("plants-answer-loaded"), endAfterWait("elephants-question")],
    [markTime("elephants-question-loaded"), endAfterWait("elephants-answer")],
    [markTime("elephants-answer-loaded"), Math.min(duration, rawEnd + 1.5)],
  ];
  const usableSegments = segments.filter(([start, end]) => end > start);
  const filters = usableSegments.map(
    ([start, end], index) =>
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`,
  );
  const joined = `${usableSegments.map((_, index) => `[v${index}]`).join("")}concat=n=${usableSegments.length}:v=1:a=0[vc]`;
  const chain = [
    "[vc]fps=30",
    "scale=1440:900:flags=lanczos",
    "setsar=1",
    "format=yuv420p",
    `drawtext=fontfile='${font}':text='F - Explore across lessons':fontsize=21:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=12:x=28:y=h-58[vout]`,
  ].join(",");
  const output = path.join(destDir, "amigosnest-explore.mp4");
  const poster = path.join(destDir, "amigosnest-explore-poster.jpg");
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-i",
      raw,
      "-filter_complex",
      `${filters.join(";")};${joined};${chain}`,
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
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const posterTime = mapTime(usableSegments, markTime("plants-question-loaded") + 0.8);
  execFileSync(
    ffmpeg,
    ["-y", "-ss", posterTime.toFixed(2), "-i", output, "-frames:v", "1", "-q:v", "3", poster],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const qa = report(output, { threshold: 6, staticRun: 12 });
  console.log(JSON.stringify({
    video: output,
    poster,
    durationSeconds: Number(usableSegments.reduce((total, [start, end]) => total + end - start, 0).toFixed(2)),
    bytes: fs.statSync(output).size,
    blackFrames: qa.black.length,
  }, null, 2));
}

const { context, page } = await launch({
  profile: PROFILE_DIR,
  initScripts: [seedLearnerScript()],
});

try {
  await page.goto(`${BASE}/?age=7&childId=${CHILD_ID}`, { waitUntil: "domcontentloaded" });
  await page.getByText(/hi milo/i).waitFor({ timeout: 60000 });
  const sources = await page.evaluate(async (childId) => {
    const authKey = Object.keys(localStorage).find((key) => key.includes("auth-token"));
    const session = authKey ? JSON.parse(localStorage.getItem(authKey) || "{}") : null;
    if (!session?.access_token) throw new Error("The demo parent session is required to verify lesson sources.");
    const response = await fetch(`/api/documents?childId=${encodeURIComponent(childId)}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Could not verify this child's learning materials (${response.status}).`);
    return (data.owned || []).map((document) => document.name);
  }, CHILD_ID);
  if (!sources.some((name) => name.endsWith("/elephants.txt")) || !sources.some((name) => name.endsWith("/plants.txt"))) {
    throw new Error(`The Explore demo needs both Plants and Elephants materials; found: ${sources.join(", ") || "none"}`);
  }
  mark("home");
  await page.waitForTimeout(pauses.screen);

  await page.getByRole("link", { name: /Explore/ }).click();
  await page.waitForURL(/\/ask/);
  await page.getByRole("heading", { name: /ask amigosnest/i }).waitFor();
  await page.getByLabel("Child age").fill("7");
  mark("explore-open");
  await page.waitForTimeout(pauses.screen);

  await page.getByLabel("Your Question").fill("How does a seed begin to grow?");
  await page.waitForTimeout(900);
  mark("plants-question-generating");
  await submitAsk(page, /get a guiding question/i, "guidingQuestion", /hint level:/i);
  mark("plants-question-loaded");
  await page.waitForTimeout(pauses.result);

  await page.getByPlaceholder(/write your answer here/i).fill("A small root grows down first.");
  await page.waitForTimeout(900);
  mark("plants-answer-generating");
  await submitAsk(page, /submit answer/i, "evaluation", /keep thinking|explain your thinking/i);
  mark("plants-answer-loaded");
  await page.waitForTimeout(pauses.result);

  await page.getByRole("button", { name: /ask a different question/i }).click();
  await page.getByLabel("Your Question").waitFor();
  mark("elephants-question");
  await page.waitForTimeout(900);
  await page.getByLabel("Your Question").fill("What are three things elephants use their trunks to do?");
  await page.waitForTimeout(900);
  mark("elephants-question-generating");
  await submitAsk(page, /get a guiding question/i, "guidingQuestion", /hint level:/i);
  mark("elephants-question-loaded");
  await page.waitForTimeout(pauses.result);

  await page.getByPlaceholder(/write your answer here/i).fill(
    "They smell food and water, pick up food, and drink water with their trunks.",
  );
  await page.waitForTimeout(900);
  mark("elephants-answer-generating");
  await submitAsk(page, /submit answer/i, "evaluation", /keep thinking|explain your thinking/i);
  mark("elephants-answer-loaded");
  await page.waitForTimeout(3000);
  mark("end");

  fs.writeFileSync(path.join(OUT_DIR, "marks-f.json"), JSON.stringify(marks, null, 2));
  const raw = await finish(context, "f-explore");
  console.log("raw:", raw);
  await exportVideo(raw);
} catch (error) {
  await context.close();
  throw error;
}
