#!/usr/bin/env node
// Live checks for the lesson-generation flow (needs dev server + Ollama +
// seeded sample docs, same prerequisites as evaluate:ask).
//   Test 1 — comprehensive lesson: 5-6 elephant concepts all taught.
//   Test 2 — no hallucination: unknown topic stays honest, no scaffolding.

import process from "node:process";

const args = process.argv.slice(2);
const baseUrl = valueAfter("--base-url") || process.env.ASK_BASE_URL || "http://localhost:3000";
const jsonOutput = args.includes("--json");

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const CONCEPT_GROUPS = [
  ["smell"],
  ["water", "drink"],
  ["pick", "grass", "leaves", "fruit", "food"],
  ["touch", "communicat"],
  ["nose", "hand"],
  ["breathe", "sound", "muscle"],
];

const FORBIDDEN_SCAFFOLD = [
  "tick (", "match the", "circle the", "write the", "(a /", "[ ]",
  "true or false", "answer:", "□",
  // Worksheet section copy + child-directed questions belong to Ask, not lessons.
  "thinking about it", "amazing fact", "?",
];

async function postLesson(topic, age) {
  const started = Date.now();
  const result = await fetch(`${baseUrl.replace(/\/$/, "")}/api/lesson`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, age }),
  });
  const response = await result.json();
  return { status: result.status, response, elapsedMs: Date.now() - started };
}

function words(text) {
  return String(text || "").split(/\s+/).filter(Boolean);
}

const results = [];

// Test 1 — comprehensive lesson (acceptance Test 1 + 2).
{
  const { status, response, elapsedMs } = await postLesson("Elephant Trunk", 8);
  const failures = [];
  const lesson = response.lesson || "";
  const lower = lesson.toLowerCase();
  if (status !== 200) failures.push(`expected HTTP 200, received ${status}`);
  if (!lesson) failures.push("missing lesson text");
  const groupsHit = CONCEPT_GROUPS.filter((group) =>
    group.some((keyword) => lower.includes(keyword)),
  ).length;
  if (groupsHit < 4) {
    failures.push(`lesson covers only ${groupsHit}/6 concept groups (need >= 4): ${lesson.slice(0, 200)}...`);
  }
  for (const bad of FORBIDDEN_SCAFFOLD) {
    if (lower.includes(bad)) failures.push(`lesson leaks worksheet scaffolding: "${bad}"`);
  }
  const count = words(lesson).length;
  if (count < 40 || count > 400) failures.push(`lesson length ${count} words outside 40-400`);
  const coverage = response._coverage;
  if (!coverage || typeof coverage.covered !== "number" || typeof coverage.important !== "number") {
    failures.push("missing _coverage diagnostics");
  } else if (coverage.important > 0 && coverage.covered / coverage.important < 0.5) {
    failures.push(`concept coverage only ${coverage.covered}/${coverage.important}`);
  }
  results.push({ id: "comprehensive-lesson", status, elapsedMs, passed: failures.length === 0, failures });
}

// Test 2 — unknown topic honesty (acceptance Test 2).
{
  const { status, response, elapsedMs } = await postLesson("Quantum Zebras of Mars", 8);
  const failures = [];
  if (status !== 200) failures.push(`expected HTTP 200, received ${status}`);
  if (response.lesson !== "I don't know. Please ask a parent to add more information.") {
    failures.push(`expected honest no-context lesson, received: ${String(response.lesson).slice(0, 160)}`);
  }
  results.push({ id: "unknown-topic-honesty", status, elapsedMs, passed: failures.length === 0, failures });
}

const passed = results.filter((r) => r.passed).length;
if (jsonOutput) {
  console.log(JSON.stringify({ baseUrl, total: results.length, passed, failed: results.length - passed, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"} ${r.id} (${r.elapsedMs}ms)`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
  console.log(`\nLesson evaluation: ${passed}/${results.length} passed`);
}
process.exitCode = passed === results.length ? 0 : 1;
