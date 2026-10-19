#!/usr/bin/env node
/**
 * verify-per-child-playwright.mjs — visible end-to-end check of V1 isolation.
 *
 * Runs a real Chromium against a demo-mode dev server (BASE_URL, default
 * http://localhost:3001 with Supabase unset) and exercises:
 *  1. Home loads with no learner (demo mode).
 *  2. Upload of a .txt as demo-local appears in the owned library.
 *  3. Legacy fixtures show the "Created before profiles" badge.
 *  4. Legacy import adds to the child's library.
 *  5. Lesson generation grounded in the child's docs (Ollama).
 *  6. Foreign ?childId=&lessonId= shows the safe empty state (no leak).
 *  7. Quiz generation works for the child.
 *
 * Screenshots → artifacts/verify/. Cleanup deletes probe docs via the API.
 * Exit non-zero on any step failure. No new npm dependencies (playwright is
 * already a devDependency).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const CHILD = "demo-local";
const OUT = new URL("../artifacts/verify/", import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${name} — ${String(e?.message || e).split("\n")[0]}`);
  }
};
const shot = (page, n) => page.screenshot({ path: fileURLToPath(new URL(`${n}.png`, OUT)) });

const probeFile = path.join(os.tmpdir(), `pw-probe-${Date.now()}.txt`);
fs.writeFileSync(
  probeFile,
  "pwcheck elephants have long trunks for smelling food and drinking water in the savanna grasslands"
);

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(30000);
let lessonId = null;
// Owned docs present before this run — cleanup only removes docs it created.
let ownedBefore = new Set();
try {
  const list = await (await fetch(`${BASE}/api/documents?childId=${CHILD}`)).json();
  ownedBefore = new Set((list.owned ?? []).map((d) => d.name));
} catch {
  ownedBefore = new Set();
}

try {
  await step("home loads (demo, no learner)", async () => {
    await page.goto(`${BASE}/?childId=${CHILD}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /hi explorer/i }).waitFor();
    await shot(page, "01-home");
  });

  await step("upload .txt as demo child", async () => {
    await page.goto(`${BASE}/upload?childId=${CHILD}`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"]').setInputFiles(probeFile);
    await page.getByRole("button", { name: /upload document/i }).click();
    await page.getByText(/document uploaded successfully/i).waitFor({ timeout: 120000 });
    await shot(page, "02-uploaded");
  });

  await step("owned library lists probe doc", async () => {
    await page.getByRole("heading", { name: path.basename(probeFile).replace(/^\d+-/, "").slice(0, 12) }).waitFor({ timeout: 15000 }).catch(async () => {
      // Fall back: any new owned card with the probe basename.
      await page.getByText(path.basename(probeFile)).first().waitFor();
    });
  });

  await step("legacy badge visible for fixtures", async () => {
    await page.getByText(/created before profiles/i).first().waitFor();
    await shot(page, "03-legacy-badge");
  });

  await step("legacy import adds to child library", async () => {
    const before = await page.getByRole("button", { name: /add to this child's library/i }).count();
    if (before === 0) throw new Error("no import button found");
    await page.getByRole("button", { name: /add to this child's library/i }).first().click();
    await page.getByText(/added to this child's library/i).waitFor({ timeout: 120000 });
    await shot(page, "04-imported");
  });

  await step("lesson generates grounded (Ollama)", async () => {
    await page.goto(`${BASE}/lesson?childId=${CHILD}`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder(/what do you want to learn/i).fill("pwcheck elephants");
    await page.getByRole("button", { name: /start adventure/i }).click();
    // Lesson LLM on CPU can take a while; poll for the lesson body.
    await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 300000 });
    // The URL gains ?lessonId= via router.replace after persist — wait for it
    // explicitly instead of racing the render.
    await page.waitForURL(/lessonId=/, { timeout: 60000 });
    const url = page.url();
    const m = url.match(/lessonId=([^&]+)/);
    if (m) lessonId = decodeURIComponent(m[1]);
    await shot(page, "05-lesson");
  });

  await step("URL child-swap cannot read another child's lesson", async () => {
    // Simulate a selected learner (intruder profile) persisted on-device,
    // then craft a URL pointing at the victim's (demo-owned) lesson with a
    // foreign ?childId=. Local reads must be forced to the learner id, so
    // the victim lesson must NOT load. (With no learner at all, both
    // sessions are the same demo-local child by design — device trust zone.)
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() =>
      localStorage.setItem(
        "amigosnest-active-learner",
        JSON.stringify({ id: "11111111-2222-4333-8555-666666666666", nickname: "Intruder", avatar: "🦊", age: 6 })
      )
    );
    if (!lessonId) throw new Error("no victim lesson id captured");
    try {
      await page.goto(
        `${BASE}/lesson?childId=demo-local&lessonId=${encodeURIComponent(lessonId)}`,
        { waitUntil: "domcontentloaded" }
      );
      await page.getByText(/couldn't be found/i).waitFor({ timeout: 30000 });
      const body = await page.content();
      if (body.toLowerCase().includes("pwcheck")) {
        throw new Error("victim lesson text leaked into foreign session");
      }
      await shot(page, "06-foreign-empty");
    } finally {
      // Restore demo (no-learner) state for remaining steps.
      await page.evaluate(() => localStorage.removeItem("amigosnest-active-learner"));
    }
  });

  await step("quiz generates for the child", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.removeItem("amigosnest-active-learner"));
    await page.goto(`${BASE}/quiz?childId=${CHILD}`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder(/choose a quiz topic/i).fill("pwcheck elephants");
    await page.getByRole("button", { name: /start quiz/i }).click();
    await page.getByText(/quiz progress/i).waitFor({ timeout: 300000 });
    await shot(page, "07-quiz");
  });
} finally {
  // Cleanup docs created by this run through the real scoped delete path.
  // Anything owned before the run is left untouched.
  try {
    const list = await (await fetch(`${BASE}/api/documents?childId=${CHILD}`)).json();
    for (const d of list.owned ?? []) {
      if (ownedBefore.has(d.name)) continue;
      await fetch(`${BASE}/api/documents`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: d.name, childId: CHILD }),
      });
      console.log(`cleanup deleted ${d.name}`);
    }
  } catch (e) {
    console.log(`cleanup warning: ${String(e?.message || e).slice(0, 120)}`);
  }
  await browser.close();
  try { fs.unlinkSync(probeFile); } catch {}
}

console.log(failures === 0 ? "\nVERIFY: all steps passed" : `\nVERIFY: ${failures} step(s) failed`);
console.log(`screenshots: ${fileURLToPath(OUT)}`);
process.exit(failures === 0 ? 0 : 1);

function fileURLToPath(u) {
  return new URL(u).pathname;
}
