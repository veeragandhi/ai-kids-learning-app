import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const BASE = process.env.DEMO_BASE_URL || "http://localhost:3100";
export const EMAIL = "demo.parent@amigosnest.test";
export const PASSWORD = "AmigosNest-Demo-2026!";
export const CHILD_ID = "ac7512fd-470e-4373-aeae-3d743f9d0781";
export const CHILD = { id: CHILD_ID, nickname: "Milo", avatar: "🐯", age: 7 };

export const ROOT = process.env.DEMO_WORK_DIR || path.join(os.tmpdir(), "amigosnest-demos");
export const RAW_DIR = path.join(ROOT, "raw");
export const OUT_DIR = path.join(ROOT, "out");
export const PROFILE_DIR = path.join(ROOT, "profile-main");
export const PROFILE_DIR_B = path.join(ROOT, "profile-b");

export function ensureDirs() {
  for (const d of [RAW_DIR, OUT_DIR]) fs.mkdirSync(d, { recursive: true });
}

/** Seeds the device-level learner profile + clears stale Ask drafts. */
export function seedLearnerScript() {
  return `(() => {
    try {
      localStorage.setItem("amigosnest-active-learner", ${JSON.stringify(JSON.stringify(CHILD))});
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("ask-draft:")) localStorage.removeItem(k);
      }
    } catch (e) {}
  })();`;
}

/** Puts the app in parent mode (no active learner) and clears stale drafts. */
export function clearLearnerScript() {
  return `(() => {
    try {
      localStorage.removeItem("amigosnest-active-learner");
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("ask-draft:")) localStorage.removeItem(k);
      }
    } catch (e) {}
  })();`;
}

/** Clears the signed-in session (used for the parent sign-in recording). */
export function clearSessionScript() {
  return `(() => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.includes("auth-token")) localStorage.removeItem(k);
      }
    } catch (e) {}
  })();`;
}

export async function launch({ profile, record = true, initScripts = [] } = {}) {
  fs.mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: record ? { dir: RAW_DIR, size: { width: 1440, height: 900 } } : undefined,
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  context.setDefaultTimeout(120000);
  context.setDefaultNavigationTimeout(120000);
  for (const s of initScripts) await context.addInitScript(s);
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

export async function signIn(page) {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Parent email").fill(EMAIL);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in as parent/i }).click();
  await page.waitForURL(/\/profile/, { timeout: 60000 });
  await page.getByRole("button", { name: /learn as milo/i }).waitFor();
}

export async function learnAsMilo(page) {
  await page.getByRole("button", { name: /learn as milo/i }).click();
  await page.waitForURL(/\/\?/, { timeout: 30000 });
  await page.getByText(/hi milo/i).waitFor({ timeout: 30000 });
}

/** Marks helper: records wall-clock offsets so the editor can trim precisely. */
export function makeMarker(page, label, marks) {
  const t = Date.now();
  marks.push({ label, t });
  console.log(`[mark] ${label} @${((t - marks[0].t) / 1000).toFixed(2)}s`);
  void page;
}

/** Closes the context and returns the raw webm path. */
export async function finish(context, outName) {
  const page = context.pages()[0];
  const video = page.video();
  const p = await video.path();
  await context.close();
  const dest = path.join(RAW_DIR, `${outName}.webm`);
  fs.copyFileSync(p, dest);
  fs.rmSync(p, { force: true });
  return dest;
}
