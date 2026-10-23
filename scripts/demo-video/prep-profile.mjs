import fs from "node:fs";
import path from "node:path";
import {
  BASE, CHILD_ID, ensureDirs, launch, PROFILE_DIR, seedLearnerScript, signIn, learnAsMilo,
} from "./rec-common.mjs";

ensureDirs();
const ELEPHANTS = process.env.DEMO_SOURCE_FILE || path.join(process.cwd(), "uploads", "elephants.txt");

const { context, page } = await launch({
  profile: PROFILE_DIR,
  record: false,
  initScripts: [seedLearnerScript()],
});

// Sign in (this also persists the session in the profile).
await signIn(page);
console.log("[prep] signed in");
await learnAsMilo(page);
console.log("[prep] learner = Milo");

// Parent mode: upload the elephant material into Milo's library.
await page.getByRole("button", { name: /parent/i }).first().click();
await page.waitForURL(/\/upload/, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.locator('input[type="file"]').setInputFiles(ELEPHANTS);
await page.getByRole("button", { name: /upload document/i }).click();
await page.getByText(/uploaded|added to the library|prepared/i).first().waitFor({ timeout: 180000 });
console.log("[prep] uploaded elephants.txt");
await page.waitForTimeout(1200);

// Back to child mode and generate a saved lesson (IndexedDB) for Milo.
await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /learn as milo/i }).waitFor();
await learnAsMilo(page);
await page.goto(`${BASE}/lesson?childId=${CHILD_ID}&topic=Elephants&age=7`, {
  waitUntil: "domcontentloaded",
});
await page.getByRole("button", { name: /start adventure/i }).click();
await page.getByRole("heading", { name: /let.s learn/i }).waitFor({ timeout: 600000 });
await page.waitForURL(/lessonId=/, { timeout: 60000 });
console.log("[prep] lesson saved:", page.url());

// Warm the routes so the recorded videos never hit a cold compile.
for (const route of ["/", "/upload", "/ask", "/quiz", "/profile"]) {
  await page.goto(`${BASE}${route}?childId=${CHILD_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
}
console.log("[prep] routes warm");

await context.close();
console.log("[prep] done");
