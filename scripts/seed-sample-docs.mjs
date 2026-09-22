#!/usr/bin/env node

/**
 * Restores the synthetic sample documents used by `npm run evaluate:ask`.
 *
 * `uploads/` is git-ignored on purpose: everything a parent uploads stays on
 * the device. Fresh clones therefore seed these fixtures into `uploads/`
 * before running the Ask evaluation.
 *
 * Usage: npm run seed:samples
 */

import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const fixturesDir = path.join(root, ".agents", "skills", "ask", "fixtures");
const uploadsDir = path.join(root, "uploads");
const metadataPath = path.join(uploadsDir, "documents.json");

const SAMPLES = ["plants.txt", "animals.txt", "dinosaurs.txt", "elephants.txt"];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

await mkdir(uploadsDir, { recursive: true });

let seeded = 0;

for (const name of SAMPLES) {
  const destination = path.join(uploadsDir, name);

  if (await exists(destination)) {
    console.log(`keep   uploads/${name} (already present)`);
    continue;
  }

  await copyFile(path.join(fixturesDir, name), destination);
  console.log(`seed   uploads/${name}`);
  seeded += 1;
}

let documents = [];

if (await exists(metadataPath)) {
  documents = JSON.parse(await readFile(metadataPath, "utf8"));
}

let approved = 0;

for (const name of SAMPLES) {
  if (!documents.some((doc) => doc.name === name)) {
    documents.push({ name, approved: true });
    approved += 1;
  }
}

if (approved > 0) {
  await writeFile(metadataPath, JSON.stringify(documents, null, 2));
  console.log(`approve ${approved} sample document(s) in uploads/documents.json`);
}

console.log(
  `Sample docs ready (${seeded} seeded). Next: node scripts/reindex-uploads.mjs, then npm run evaluate:ask`
);