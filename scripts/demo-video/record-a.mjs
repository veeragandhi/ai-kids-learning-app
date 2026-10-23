import fs from "node:fs";
import path from "node:path";
import {
  BASE, CHILD_ID, ensureDirs, finish, launch, makeMarker, OUT_DIR, PROFILE_DIR, seedLearnerScript,
} from "./rec-common.mjs";

ensureDirs();
const marks = [];
const mark = (label) => makeMarker(null, label, marks);

const { context, page } = await launch({
  profile: PROFILE_DIR,
  initScripts: [seedLearnerScript()],
});
mark("t0");

// ── Home: the child-facing start screen ────────────────────────────────
await page.goto(`${BASE}/?age=7&childId=${CHILD_ID}`, { waitUntil: "domcontentloaded" });
await page.getByText(/hi milo/i).waitFor();
await page.getByText(/meet amigosnest/i).waitFor();
mark("home-loaded");
await page.waitForTimeout(1600);

// Scroll down to the topic cards and the three learning actions.
await page.mouse.move(720, 500);
await page.mouse.wheel(0, 420);
await page.waitForTimeout(700);
mark("home-topics");
await page.waitForTimeout(1500);

await page.mouse.wheel(0, 220);
await page.waitForTimeout(600);
mark("home-actions");
await page.waitForTimeout(1100);

// ── Into the learning experience ───────────────────────────────────────
await page.getByRole("link", { name: /Start Learning/ }).click();
await page.waitForURL(/\/lesson/, { timeout: 30000 });
await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 60000 });
mark("lesson-open");
await page.waitForTimeout(2600);

await page.getByText(/your ai lesson/i).scrollIntoViewIfNeeded();
mark("lesson-header");
await page.waitForTimeout(2200);

await page.locator("h3", { hasText: "Learn" }).first().scrollIntoViewIfNeeded();
await page.mouse.wheel(0, 320);
mark("lesson-body");
await page.waitForTimeout(2400);

await page.getByText(/ready for a quiz/i).scrollIntoViewIfNeeded();
mark("lesson-cta");
await page.waitForTimeout(2200);

await page.getByText(/your ai lesson/i).scrollIntoViewIfNeeded();
mark("lesson-back-to-top");
await page.waitForTimeout(1600);

fs.writeFileSync(
  path.join(OUT_DIR, "marks-a.json"),
  JSON.stringify(marks, null, 2),
);

const raw = await finish(context, "a-overview");
console.log("raw:", raw);
