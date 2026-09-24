/**
 * Semi-auto capture of REAL AmigosNest screenshots for the social video.
 * Needs `npm run dev` (http://localhost:3000). Saves full-page PNGs to
 * video/assets/ — you confirm/crop the best frames; no UI is ever faked.
 * Usage: npm run video:social:capture
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(root, "video/assets");
const base = process.env.SOCIAL_BASE_URL ?? "http://localhost:3000";

const shots = [
  { route: "/lesson", file: "lesson.png" },
  { route: "/quiz", file: "quiz.png" },
  { route: "/ask", file: "ask.png" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const s of shots) {
  await page.goto(base + s.route, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, s.file), fullPage: true });
  console.log("saved", `video/assets/${s.file}`, `(generate content first at ${s.route}, then rerun to capture the result)`);
}
await browser.close();
console.log("Done. Confirm each PNG shows REAL generated content, then: npm run video:social:shots");
