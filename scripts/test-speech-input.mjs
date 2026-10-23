#!/usr/bin/env node
/**
 * test-speech-input.mjs — voice-input (Web Speech API) regression tests.
 *
 * Runs a real Chromium against a dev server (BASE_URL, default
 * http://localhost:3001) with the Web Speech API MOCKED via addInitScript, so
 * no physical microphone or external speech service is needed in CI.
 *
 * Covers: start/stop, final vs interim transcripts, duplicate-result
 * prevention, existing-draft preservation, no auto-submission, unsupported
 * browsers, permission/no-speech/network errors, and that typed questions keep
 * working. The mocked recognizer never submits anything itself — the assertions
 * confirm the app does not either.
 *
 * No new npm dependencies (playwright is already a devDependency).
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const CHILD = "demo-local";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass += 1;
  console.log(`PASS ${name}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`FAIL ${name} — ${detail}`);
}
async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, String(e?.message || e).split("\n")[0]);
  }
}

// Web Speech API mock injected before any page script runs. Instances register
// themselves on window.__speechMock so the test can drive results/errors.
function installSpeechMock() {
  const mock = { instances: [] };
  window.__speechMock = mock;

  class MockSpeechRecognition extends EventTarget {
    constructor() {
      super();
      this.lang = "";
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.started = false;
      this.aborted = false;
      mock.instances.push(this);
    }
    start() {
      if (this.started) throw new Error("start() called while already started");
      this.started = true;
      queueMicrotask(() => this.onstart && this.onstart(new Event("start")));
    }
    stop() {
      this.started = false;
      queueMicrotask(() => this.onend && this.onend(new Event("end")));
    }
    abort() {
      this.started = false;
      this.aborted = true;
      queueMicrotask(() => this.onend && this.onend(new Event("end")));
    }
    emitResult(list) {
      const results = list.map((item) => {
        const result = [{ transcript: item.transcript, confidence: 1 }];
        result.isFinal = Boolean(item.isFinal);
        return result;
      });
      results.item = (i) => results[i];
      if (this.onresult) this.onresult({ results, resultIndex: 0 });
    }
    emitError(code) {
      if (this.onerror) this.onerror({ error: code, message: code });
    }
  }

  window.SpeechRecognition = MockSpeechRecognition;
  window.webkitSpeechRecognition = MockSpeechRecognition;
}

// Chromium ships webkitSpeechRecognition even in headless mode, so an
// "unsupported browser" must be simulated by removing both constructors before
// any app script runs.
function removeSpeechSupport() {
  try {
    delete window.SpeechRecognition;
  } catch {
    window.SpeechRecognition = undefined;
  }
  try {
    delete window.webkitSpeechRecognition;
  } catch {
    window.webkitSpeechRecognition = undefined;
  }
}

async function emit(page, list) {
  await page.evaluate((payload) => {
    const instances = window.__speechMock.instances;
    const instance = instances[instances.length - 1];
    instance.emitResult(payload);
  }, list);
}

async function emitError(page, code) {
  await page.evaluate((c) => {
    const instances = window.__speechMock.instances;
    const instance = instances[instances.length - 1];
    instance.emitError(c);
  }, code);
}

async function waitValue(page, ariaLabel, expected) {
  await page.waitForFunction(
    ({ label, expected }) => {
      const el = document.querySelector(`textarea[aria-label="${label}"]`);
      return el instanceof HTMLTextAreaElement && el.value === expected;
    },
    { label: ariaLabel, expected },
    { timeout: 5000 }
  );
}

async function openAsk(browser, { mock, removeSpeech = false }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const counts = { ask: 0 };
  page.on("request", (req) => {
    if (req.url().includes("/api/ask")) counts.ask += 1;
  });
  if (mock) await page.addInitScript(installSpeechMock);
  if (removeSpeech) await page.addInitScript(removeSpeechSupport);
  await page.goto(`${BASE}/ask?childId=${CHILD}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: /ask amigosnest/i }).waitFor();
  return { context, page, counts };
}

const browser = await chromium.launch();
try {
  // 1. Mocked support shows the microphone button.
  await step("mic button appears when Web Speech API is supported", async () => {
    const { context, page } = await openAsk(browser, { mock: true });
    try {
      await page
        .getByRole("button", { name: /speak instead of typing/i })
        .waitFor({ timeout: 5000 });
      const disclosure = await page
        .getByText(/may send your audio to the internet/i)
        .count();
      if (disclosure === 0) throw new Error("privacy disclosure missing");
    } finally {
      await context.close();
    }
  });

  // 2. Start -> interim -> final, appended to the existing typed draft.
  await step("start listening, then append final transcript to draft", async () => {
    const { context, page } = await openAsk(browser, { mock: true });
    try {
      // Wait for hydration (the mic button only renders client-side) before
      // typing, otherwise React's first client render can overwrite the value.
      const mic = page.getByRole("button", { name: /speak instead of typing/i });
      await mic.waitFor({ timeout: 5000 });
      const textarea = page.getByLabel("Your question");
      await textarea.fill("What is");
      await mic.click();
      await page.getByText(/listening… tap stop/i).waitFor({ timeout: 5000 });

      await emit(page, [{ transcript: "photo", isFinal: false }]);
      await page.getByText(/hearing: photo/i).waitFor({ timeout: 5000 });

      await emit(page, [{ transcript: "photosynthesis", isFinal: true }]);
      await waitValue(page, "Your question", "What is photosynthesis");
    } finally {
      await context.close();
    }
  });

  // 3. Re-firing the same final result must not duplicate text; a new final
  //    segment is appended exactly once.
  await step("duplicate final results are not appended twice", async () => {
    const { context, page } = await openAsk(browser, { mock: true });
    try {
      await page.getByRole("button", { name: /speak instead of typing/i }).click();
      await page.getByText(/listening… tap stop/i).waitFor({ timeout: 5000 });

      const first = [{ transcript: "photosynthesis ", isFinal: true }];
      await emit(page, first);
      await waitValue(page, "Your question", "photosynthesis");

      await emit(page, first); // same list again
      await page.waitForTimeout(150);
      await waitValue(page, "Your question", "photosynthesis");

      await emit(page, [
        { transcript: "photosynthesis ", isFinal: true },
        { transcript: "and how plants make food", isFinal: true },
      ]);
      await waitValue(
        page,
        "Your question",
        "photosynthesis and how plants make food"
      );
    } finally {
      await context.close();
    }
  });

  // 4. Stop ends the session and returns to idle.
  await step("stop ends the recognition session", async () => {
    const { context, page } = await openAsk(browser, { mock: true });
    try {
      await page.getByRole("button", { name: /speak instead of typing/i }).click();
      await page.getByText(/listening… tap stop/i).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: /stop listening/i }).click();
      await page.getByText(/tap the microphone to speak/i).waitFor({ timeout: 5000 });
      const ended = await page.evaluate(() => {
        const instances = window.__speechMock.instances;
        const instance = instances[instances.length - 1];
        return instance.started === false;
      });
      if (!ended) throw new Error("recognizer still marked as started");
    } finally {
      await context.close();
    }
  });

  // 5. Speech recognition never submits on its own; Send is required.
  await step("recognition never auto-submits the question", async () => {
    const { context, page, counts } = await openAsk(browser, { mock: true });
    try {
      await page.getByRole("button", { name: /speak instead of typing/i }).click();
      await emit(page, [{ transcript: "why is the sky blue", isFinal: true }]);
      await waitValue(page, "Your question", "why is the sky blue");
      await page.getByRole("button", { name: /stop listening/i }).click();
      await page.waitForTimeout(300);
      if (counts.ask !== 0) {
        throw new Error(`expected 0 /api/ask requests, saw ${counts.ask}`);
      }
      // The existing Send button is still the way to submit.
      const send = page.getByRole("button", { name: /get a guiding question/i });
      if ((await send.count()) === 0) throw new Error("Send button missing");
    } finally {
      await context.close();
    }
  });

  // 6. Recognition errors are recoverable and typed input keeps working.
  await step("permission error is shown and typing still works", async () => {
    const { context, page } = await openAsk(browser, { mock: true });
    try {
      await page.getByRole("button", { name: /speak instead of typing/i }).click();
      await page.getByText(/listening… tap stop/i).waitFor({ timeout: 5000 });
      await emitError(page, "not-allowed");
      await page
        .getByText(/microphone access is blocked/i)
        .waitFor({ timeout: 5000 });
      const textarea = page.getByLabel("Your question");
      await textarea.fill("typed after error");
      await waitValue(page, "Your question", "typed after error");
    } finally {
      await context.close();
    }
  });

  // 7. Map other failure codes to friendly, non-fatal messages.
  for (const [code, pattern] of [
    ["no-speech", /didn't hear anything/i],
    ["network", /connection problem/i],
    ["audio-capture", /couldn't find a microphone/i],
  ]) {
    await step(`error "${code}" shows a recoverable message`, async () => {
      const { context, page } = await openAsk(browser, { mock: true });
      try {
        await page
          .getByRole("button", { name: /speak instead of typing/i })
          .click();
        await emitError(page, code);
        await page.getByText(pattern).waitFor({ timeout: 5000 });
      } finally {
        await context.close();
      }
    });
  }

  // 8. Unsupported browser: no mic button, textarea still usable.
  await step("unsupported browser hides the mic but typing still works", async () => {
    const { context, page } = await openAsk(browser, {
      mock: false,
      removeSpeech: true,
    });
    try {
      await page.waitForTimeout(300);
      const mic = await page
        .getByRole("button", { name: /speak instead of typing/i })
        .count();
      if (mic !== 0) throw new Error("mic button shown without API support");
      const textarea = page.getByLabel("Your question");
      await textarea.fill("no mic here");
      await waitValue(page, "Your question", "no mic here");
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log("failures:");
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
