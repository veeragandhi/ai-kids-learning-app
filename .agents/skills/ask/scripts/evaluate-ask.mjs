#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

const scenariosPath = new URL("../evaluations/scenarios.json", import.meta.url);
const scenarios = JSON.parse(await readFile(scenariosPath, "utf8"));
const args = process.argv.slice(2);
const baseUrl = valueAfter("--base-url") || process.env.ASK_BASE_URL || "http://localhost:3000";
const selectedId = valueAfter("--scenario");
const jsonOutput = args.includes("--json");
const failFast = args.includes("--fail-fast");

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function textOf(response) {
  return Object.values(response || {}).filter((value) => typeof value === "string").join(" ");
}

function words(text) {
  return normalize(text).split(/\s+/).filter(Boolean);
}

function includesAny(text, terms) {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
}

function includesAll(text, terms) {
  const normalized = normalize(text);
  return terms.every((term) => normalized.includes(normalize(term)));
}

function correctnessMatches(actual, expected) {
  const value = normalize(actual);
  if (expected === "partial") return value.includes("partial");
  return value.includes(expected);
}

function hasUncertainty(text) {
  return includesAny(text, [
    "i don't know",
    "i do not know",
    "not enough information",
    "cannot find",
    "not in the text",
    "text does not say",
    "ask a parent",
  ]);
}

function hasAnswerLeak(response, evidence) {
  const answerText = textOf(response);
  return includesAll(answerText, evidence);
}

function evaluateResponse(scenario, status, response, elapsedMs) {
  const failures = [];
  const expect = scenario.expect || {};
  const responseText = textOf(response);

  if (status !== 200) failures.push(`expected HTTP 200, received ${status}`);

  if (scenario.mode === "question") {
    if (expect.noContextOrUncertainty) {
      if (!(typeof response.answer === "string" && hasUncertainty(response.answer)) && !hasUncertainty(responseText)) {
        failures.push("expected an honest no-context or uncertainty response");
      }
    } else {
      if (response.type !== "guidingQuestion") failures.push(`expected guidingQuestion type, received ${String(response.type)}`);
      if (!response.question || typeof response.question !== "string") failures.push("missing guiding question");
      if (response.questionType !== expect.questionType) failures.push(`expected questionType ${expect.questionType}, received ${String(response.questionType)}`);
      if (response.question && !/^[\x00-\x7F]*$/.test(response.question)) failures.push("guiding question is not plain English/ASCII");
      if (expect.notYesNo && /^(can|could|do|does|did|is|are|was|were|will|would)\b/i.test(response.question || "")) failures.push("guiding question is yes/no shaped");
      if (expect.notRepeatQuestion && normalize(response.question) === normalize(scenario.payload.question)) failures.push("guiding question repeats the original question");
    }
  }

  if (scenario.mode === "answer") {
    if (response.type !== "evaluation") failures.push(`expected evaluation type, received ${String(response.type)}`);
    if (!response.feedback || typeof response.feedback !== "string") failures.push("missing evaluation feedback");
    if (!correctnessMatches(response.correctness, expect.correctness)) failures.push(`expected correctness ${expect.correctness}, received ${String(response.correctness)}`);
    if (response.nextPrompt !== expect.nextPrompt) failures.push(`expected nextPrompt ${expect.nextPrompt}, received ${String(response.nextPrompt)}`);
  }

  if (scenario.mode === "explanation") {
    if (response.type !== "explanationFeedback") failures.push(`expected explanationFeedback type, received ${String(response.type)}`);
    if (!Number.isFinite(Number(response.score))) failures.push("score is not numeric");
    if (expect.scoreAtLeast !== undefined && Number(response.score) < expect.scoreAtLeast) failures.push(`score ${response.score} is below ${expect.scoreAtLeast}`);
    if (expect.scoreAtMost !== undefined && Number(response.score) > expect.scoreAtMost) failures.push(`score ${response.score} is above ${expect.scoreAtMost}`);
    if (!response.feedback || typeof response.feedback !== "string") failures.push("missing explanation feedback");
    if (!response.finalPrompt || typeof response.finalPrompt !== "string") failures.push("missing final prompt");
  }

  if (expect.evidence && !expect.noContextOrUncertainty && !includesAny(responseText, expect.evidence)) {
    failures.push(`response contains none of the expected grounding signals: ${expect.evidence.join(", ")}`);
  }

  if (expect.mustNotLeakEvidence && hasAnswerLeak(response, expect.mustNotLeakEvidence)) {
    failures.push("response contains all forbidden answer-leakage terms");
  }

  if (expect.feedbackMustNotInclude && includesAny(response.feedback, expect.feedbackMustNotInclude)) {
    failures.push("feedback contains forbidden unsupported wording");
  }

  const maxWords = expect.ageMaxWords;
  if (maxWords && words(responseText).length > maxWords) failures.push(`response is too long for the scenario age (${words(responseText).length} words > ${maxWords})`);

  return { id: scenario.id, mode: scenario.mode, status, elapsedMs, passed: failures.length === 0, failures, response };
}

async function runScenario(scenario) {
  const started = Date.now();
  try {
    const result = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...scenario.payload, mode: scenario.mode }),
    });
    const response = await result.json();
    return evaluateResponse(scenario, result.status, response, Date.now() - started);
  } catch (error) {
    return { id: scenario.id, mode: scenario.mode, status: 0, elapsedMs: Date.now() - started, passed: false, failures: [`request failed: ${error.message}`] };
  }
}

const selectedScenarios = selectedId ? scenarios.filter((scenario) => scenario.id === selectedId) : scenarios;
if (!selectedScenarios.length) {
  console.error(`No scenario found for --scenario ${selectedId}`);
  process.exit(2);
}

const results = [];
for (const scenario of selectedScenarios) {
  const result = await runScenario(scenario);
  results.push(result);
  if (!jsonOutput) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id} (${result.mode}, ${result.elapsedMs}ms)`);
    for (const failure of result.failures) console.log(`  - ${failure}`);
  }
  if (failFast && !result.passed) break;
}

const passed = results.filter((result) => result.passed).length;
const summary = { baseUrl, total: results.length, passed, failed: results.length - passed, results };
if (jsonOutput) console.log(JSON.stringify(summary, null, 2));
else console.log(`\nAsk evaluation: ${passed}/${results.length} passed`);
process.exitCode = passed === results.length ? 0 : 1;
