import fs from "node:fs";
import path from "node:path";
import {
  BASE, ensureDirs, finish, launch, makeMarker, OUT_DIR, PROFILE_DIR_B,
} from "./rec-common.mjs";

ensureDirs();
const marks = [];
const mark = (label) => makeMarker(null, label, marks);

// A dedicated, never-signed-in profile so the parent sign-in is genuine.
const { context, page } = await launch({ profile: PROFILE_DIR_B });
mark("t0");

// ── Parent sign-in (fictional demo account) ────────────────────────────
await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
await page.getByPlaceholder("Parent email").waitFor();
mark("auth-form");
await page.waitForTimeout(1300);

await page.getByPlaceholder("Parent email").fill("demo.parent@amigosnest.test");
mark("email-typed");
await page.waitForTimeout(1100);
await page.getByPlaceholder("Password").fill("AmigosNest-Demo-2026!");
mark("password-typed");
await page.waitForTimeout(800);

await page.getByRole("button", { name: /sign in as parent/i }).click();
await page.waitForURL(/\/profile/, { timeout: 60000 });
await page.getByRole("heading", { name: /parent dashboard/i }).waitFor();
await page.getByRole("button", { name: /learn as milo/i }).waitFor();
mark("dashboard");
await page.waitForTimeout(3600);

// Point at the child card, then hand the device to the child.
await page.getByText(/milo/i).first().hover();
await page.waitForTimeout(700);
mark("child-card");
await page.waitForTimeout(1400);

// ── Child profile → learning experience ────────────────────────────────
await page.getByRole("button", { name: /learn as milo/i }).click();
await page.waitForURL(/\/(|\\?.*)$/, { timeout: 30000 });
await page.getByText(/hi milo/i).waitFor();
mark("home-as-milo");
await page.waitForTimeout(2600);

// ── The child's learning library (parent-managed material) ─────────────
await page.getByRole("link", { name: /library/i }).first().click();
await page.waitForURL(/\/upload/, { timeout: 30000 });
await page.getByText(/my library/i).waitFor();
mark("child-library");
await page.waitForTimeout(3200);

fs.writeFileSync(path.join(OUT_DIR, "marks-b.json"), JSON.stringify(marks, null, 2));
const raw = await finish(context, "b-parent-dashboard");
console.log("raw:", raw);
