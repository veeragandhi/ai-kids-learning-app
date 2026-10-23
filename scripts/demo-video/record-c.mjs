import fs from "node:fs";
import path from "node:path";
import {
  BASE, CHILD_ID, clearLearnerScript, ensureDirs, finish, launch, makeMarker, OUT_DIR,
  PROFILE_DIR,
} from "./rec-common.mjs";

ensureDirs();
const marks = [];
const mark = (label) => makeMarker(null, label, marks);
const ELEPHANTS = process.env.DEMO_SOURCE_FILE || path.join(process.cwd(), "uploads", "elephants.txt");

// Parent mode: the learner chip is cleared so the parent dashboard/library
// is shown. The parent session (already stored in this profile) stays signed in.
const { context, page } = await launch({
  profile: PROFILE_DIR,
  initScripts: [clearLearnerScript()],
});
mark("t0");

// ── 1. Parent library (the real upload screen) ─────────────────────────
await page.goto(`${BASE}/upload?childId=${CHILD_ID}`, { waitUntil: "domcontentloaded" });
await page.getByText(/parent dashboard/i).first().waitFor();
await page.getByText(/upload learning material/i).waitFor();
mark("parent-library");
await page.waitForTimeout(3200);

// ── 2. Upload the learning material (real upload → chunk → embed) ──────
await page.locator('input[type="file"]').setInputFiles(ELEPHANTS);
await page.waitForTimeout(700);
mark("file-picked");
await page.getByRole("button", { name: /upload document/i }).click();
await page.getByText(/uploaded|added to the library|prepared/i).first().waitFor({ timeout: 180000 });
mark("upload-done");
await page.waitForTimeout(3000);

// ── 3. Parent dashboard → the child profile ────────────────────────────
await page.getByRole("link", { name: /parent/i }).first().click();
await page.waitForURL(/\/profile/, { timeout: 30000 });
await page.getByRole("heading", { name: /parent dashboard/i }).waitFor();
mark("dashboard");
await page.waitForTimeout(1400);

await page.getByRole("button", { name: /learn as milo/i }).click();
await page.waitForURL(/\/\?/, { timeout: 30000 });
await page.getByText(/hi milo/i).waitFor();
mark("home-as-milo");
await page.waitForTimeout(2400);

// ── 4. Into the lesson: generate one from the uploaded material ────────
await page.getByRole("link", { name: /Start Learning/ }).click();
await page.waitForURL(/\/lesson/, { timeout: 30000 });
await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 60000 });
mark("saved-lesson");
await page.waitForTimeout(2200);

await page.getByRole("button", { name: /start adventure/i }).click();
await page.getByText(/preparing your lesson/i).waitFor({ timeout: 30000 });
mark("generating");
await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 600000 });
mark("lesson-generated");
await page.waitForTimeout(3200);

// ── 5. Reading the lesson ──────────────────────────────────────────────
await page.locator("h3", { hasText: "Learn" }).first().scrollIntoViewIfNeeded();
await page.mouse.wheel(0, 300);
mark("lesson-body");
await page.waitForTimeout(2600);

await page.getByText(/ready for a quiz/i).scrollIntoViewIfNeeded();
mark("lesson-cta");
await page.waitForTimeout(2400);

fs.writeFileSync(path.join(OUT_DIR, "marks-c.json"), JSON.stringify(marks, null, 2));
const raw = await finish(context, "c-lesson-workflow");
console.log("raw:", raw);
