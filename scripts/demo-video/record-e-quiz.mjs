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

// ── 1. Home → saved lesson ─────────────────────────────────────────────
await page.goto(`${BASE}/?childId=${CHILD_ID}`, { waitUntil: "domcontentloaded" });
await page.getByText(/hi milo/i).waitFor({ timeout: 60000 });
await page.waitForTimeout(1200);
await page.getByRole("link", { name: /Start Learning/ }).click();
await page.waitForURL(/\/lesson/, { timeout: 30000 });
await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 60000 });
mark("lesson-open");
await page.waitForTimeout(2000);

// ── 2. Go to quiz from lesson ──────────────────────────────────────────
await page.getByText(/ready for a quiz/i).scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
mark("quiz-cta");
await page.getByRole("button", { name: /start quiz/i }).click();
await page.waitForURL(/\/quiz/, { timeout: 30000 });
mark("quiz-start");
await page.waitForTimeout(2000);

// ── 3. Wait for questions to load ──────────────────────────────────────
await page.getByRole("button", { name: /^start quiz$/i }).click();
mark("quiz-generating");
await page.getByText(/^Question 1$/i).waitFor({ timeout: 600000 });
mark("quiz-loaded");
await page.waitForTimeout(2500);

// ── 4. Answer all questions ────────────────────────────────────────────
const questionCards = page.locator(".space-y-6 > div");
const questionCount = await questionCards.count();
for (let q = 1; q <= questionCount; q++) {
  const card = questionCards.nth(q - 1);
  await card.getByText(new RegExp(`^Question ${q}$`, "i")).waitFor({ timeout: 30000 });
  await card.locator("button").first().click();
  mark(`q${q}-answered`);
  await page.waitForTimeout(1400);
}

// ── 5. Submit and show results ─────────────────────────────────────────
await page.getByRole("button", { name: /submit answers/i }).click();
await page.getByText(/score|correct|quiz complete/i).first().waitFor({ timeout: 120000 });
mark("quiz-result");
await page.waitForTimeout(4000);

// ── 6. Review score ────────────────────────────────────────────────────
await page.mouse.wheel(0, -200);
mark("review");
await page.waitForTimeout(2500);

fs.writeFileSync(path.join(OUT_DIR, "marks-e.json"), JSON.stringify(marks, null, 2));
const raw = await finish(context, "e-quiz");
console.log("raw:", raw);
