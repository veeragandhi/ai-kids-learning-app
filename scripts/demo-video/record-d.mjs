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

// ── 1. Open the saved lesson and use its own "Ask about this lesson" CTA ──
await page.goto(`${BASE}/lesson?childId=${CHILD_ID}`, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 60000 });
await page.getByRole("button", { name: /ask about this lesson/i }).scrollIntoViewIfNeeded();
mark("lesson-cta");
await page.waitForTimeout(1500);

await page.getByRole("button", { name: /ask about this lesson/i }).click();
await page.waitForURL(/\/ask/, { timeout: 30000 });
await page.getByText(/asking about your lesson on/i).waitFor({ timeout: 60000 });
mark("ask-scoped");
await page.waitForTimeout(2400);

// ── 2. A child-facing question, grounded in that lesson ────────────────
await page
  .getByPlaceholder(/what do you want to learn from your document/i)
  .fill("What does an elephant use its trunk for?");
await page.waitForTimeout(1000);
mark("question-typed");
await page.getByRole("button", { name: /get a guiding question/i }).click();
await page.getByText(/hint level/i).waitFor({ timeout: 300000 });
mark("guiding-question");
await page.waitForTimeout(2600);

// ── 3. First attempt (partial) → progressive hint ──────────────────────
await page.getByPlaceholder(/write your answer here/i).fill("It helps them smell things.");
await page.waitForTimeout(900);
await page.getByRole("button", { name: /submit answer/i }).click();
await page.getByText(/keep thinking|explain your thinking/i).first().waitFor({ timeout: 300000 });
mark("first-attempt");
await page.waitForTimeout(2600);

// ── 4. Fuller attempts → the app asks the child to explain ─────────────
const STRONG = [
  "They use their trunks to smell food and water, pick up grass and fruit, drink water, and touch other elephants.",
  "An elephant's trunk works like a nose and a hand at the same time: it smells food and water, picks up grass, leaves and fruit, sucks up water to drink, and touches other elephants to communicate.",
  "The trunk is like a nose and a hand together. It smells food and water, picks up grass and fruit, drinks by sucking water up, and touches other elephants to talk to them.",
];
for (let attempt = 0; attempt < STRONG.length; attempt++) {
  if (await page.getByPlaceholder(/explain how you knew your answer/i).count()) break;
  const box = page.getByPlaceholder(/tell me what you think in your own words/i);
  if (!(await box.count())) break;
  await box.fill(STRONG[attempt]);
  mark(`attempt-${attempt + 1}`);
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /try again/i }).click();
  await page
    .getByText(/keep thinking|explain your thinking/i)
    .first()
    .waitFor({ timeout: 240000 });
  await page.waitForTimeout(1200);
}
const atExplain = await page.getByPlaceholder(/explain how you knew your answer/i).count();
console.log("[d] reached explain step:", Boolean(atExplain));
mark("second-attempt");
await page.waitForTimeout(2400);

// ── 5. The child explains their thinking → score ───────────────────────
const expl = page.getByPlaceholder(/explain how you knew your answer/i);
if (await expl.count()) {
  await expl.fill(
    "The lesson said a trunk is like a nose and a hand, and it listed smelling, picking up food, drinking and touching other elephants.",
  );
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /submit explanation/i }).click();
  await page.getByText(/conversation complete/i).first().waitFor({ timeout: 300000 });
}
mark("explanation");
await page.waitForTimeout(2400);

// ── 6. Scroll back up: the lesson scope + the whole exchange ───────────
await page.getByRole("heading", { name: /ask amigosnest/i }).scrollIntoViewIfNeeded();
mark("review");
await page.waitForTimeout(2200);

fs.writeFileSync(path.join(OUT_DIR, "marks-d.json"), JSON.stringify(marks, null, 2));
const raw = await finish(context, "d-guided-learning");
console.log("raw:", raw);
