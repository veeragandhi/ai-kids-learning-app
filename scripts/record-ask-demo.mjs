import { chromium } from "playwright";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { convertToMp4, removeFileIfExists } from "./convert-to-mp4.mjs";

const baseUrl = process.env.DEMO_BASE_URL || "http://localhost:3000";
const outputDir = path.resolve("artifacts/demo-video");

// ---------------------------------------------------------------------------
// Scripted Socratic conversation shown in the demo. Each step's "assistant"
// text mirrors what the real /api/ask route returns based on responseState,
// including the graceful "I don't remember" ending.
// ---------------------------------------------------------------------------
const turns = [
  {
    questionText: "What did the lesson say about plant and water?",
  },
  {
    step: "Plants need water to grow",
    button: "Submit answer",
    placeholder: "Write your answer here...",
    evaluation: {
      type: "evaluation",
      responseState: "partially_correct",
      correctness: "partial",
      feedback: "Good memory. That is one thing the lesson said.",
      nextPrompt: "What else did the lesson say about water?",
      continueLearning: true,
      hintLevel: 2,
      source: "Document",
    },
  },
  {
    step: "I think sunlight is needed to grow plants",
    button: "Try again",
    placeholder: "Tell me what you think in your own words.",
    evaluation: {
      type: "evaluation",
      responseState: "partially_correct",
      correctness: "partial",
      feedback: "Good memory. That is one thing the lesson said.",
      nextPrompt: "What else did the lesson say about sunlight?",
      continueLearning: true,
      hintLevel: 2,
      source: "Document",
    },
  },
  {
    step: "That's all I remember",
    button: "Try again",
    placeholder: "Tell me what you think in your own words.",
    evaluation: {
      type: "evaluation",
      responseState: "don't_remember",
      correctness: "partial",
      feedback:
        "That is okay. You do not need to remember the exact words. Let's use a clue from the lesson to find the answer together.",
      nextPrompt: "What clue can you find in the lesson about this?",
      continueLearning: true,
      hintLevel: 2,
      source: "Document",
    },
  },
  {
    step: "I dont remember. Can you tell me?",
    button: "Try again",
    placeholder: "Tell me what you think in your own words.",
    evaluation: {
      type: "evaluation",
      responseState: "don't_remember",
      correctness: "partial",
      feedback:
        "Great try thinking about it! Plants mainly need things like water, sunlight, air, and nutrients from the soil to grow well.",
      nextPrompt: "Want to try another question from the lesson?",
      continueLearning: false,
      hintLevel: 3,
      source: "Document",
    },
  },
];

const explanationFeedback = {
  type: "explanationFeedback",
  score: 85,
  feedback: "That is exactly it! You used the lesson's details to explain your thinking.",
  finalPrompt: "Which lesson detail helped you decide?",
  retry: false,
  source: "Document",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildConversation(body, assistantText) {
  const base = Array.isArray(body.conversation)
    ? body.conversation.filter(
        (t) =>
          t &&
          (t.role === "child" || t.role === "assistant") &&
          typeof t.content === "string" &&
          t.content.trim().length > 0,
      )
    : [];
  const childContent =
    body.mode === "answer"
      ? (body.studentAnswer || "").trim()
      : body.mode === "explanation"
        ? (body.explanation || "").trim()
        : (body.question || "").trim();
  return base.concat(
    { role: "child", content: childContent },
    { role: "assistant", content: assistantText },
  );
}

// ---------------------------------------------------------------------------
// Route mocking – simulates the real /api/ask state machine
// ---------------------------------------------------------------------------
function installAskRoutes(page) {
  return page.route("**/api/ask", async (route) => {
    const body = route.request().postDataJSON();
    const mode = body?.mode || "question";
    let payload;

    if (mode === "question") {
      const text = turns[0].questionText;
      payload = {
        type: "guidingQuestion",
        question: text,
        hintLevel: 1,
        questionType: "guided",
        source: "Document",
      };
      payload.conversation = buildConversation(body, text);
    } else if (mode === "explanation") {
      payload = { ...explanationFeedback };
      payload.conversation = buildConversation(
        body,
        `${explanationFeedback.feedback}\n\n${explanationFeedback.finalPrompt}`,
      );
    } else {
      const answer = (body?.studentAnswer || "").trim().toLowerCase();
      const matched = turns.slice(1).find((t) => answer.includes(t.step.toLowerCase()));
      const turn = matched || turns[turns.length - 1];
      const { evaluation } = turn;
      const text = `${evaluation.feedback}\n\n${evaluation.nextPrompt}`;
      payload = { ...evaluation };
      payload.conversation = buildConversation(body, text);
    }

    await route.fulfill({ json: payload });
  });
}

async function show(page, selector, milliseconds = 2600) {
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
  await pause(milliseconds);
}
// ---------------------------------------------------------------------------
// Recording flow
// ---------------------------------------------------------------------------
async function record() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  await installAskRoutes(page);

  // 1. Home page
  await page.goto(baseUrl);
  await show(page, "text=Meet AmigosNest!", 2200);
  await show(page, "text=Ask AmigosNest", 2200);

  // 2. Navigate to the Ask page through the UI
  await page.click('a[href="/ask"]');
  await show(page, "text=Ask AmigosNest", 1800);

  // 3. Ask the first question
  await page
    .locator('textarea[placeholder="What do you want to learn from your document?"]')
    .fill("should i give cardboard so that plants can grow");
  await pause(1600);
  await page.getByRole("button", { name: "Get a guiding question" }).click();
  await show(page, "text=What did the lesson say about plant and water?", 3200);

  // 4. Walk through each Socratic turn
  for (const turn of turns.slice(1)) {
    await page.locator(`textarea[placeholder="${turn.placeholder}"]`).fill(turn.step);
    await pause(1500);
    await page.getByRole("button", { name: turn.button }).click();
    await show(page, `text=${turn.evaluation.feedback}`, 3600);
    await show(page, `text=${turn.evaluation.nextPrompt}`, 2400);
  }

  // 5. Explanation step (the graceful end keeps the conversation open for review)
  await page
    .locator('textarea[placeholder="Explain how you knew your answer."]')
    .fill("The lesson says plants need water, sunlight, soil, and nutrients to grow well.");
  await pause(1500);
  await page.getByRole("button", { name: "Submit explanation" }).click();
  await show(page, "text=Conversation complete", 3800);

  // 6. Wrap up the video: record the webm, convert to MP4, remove the webm
  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  const mp4Path = await convertToMp4(videoPath, outputDir);
  const dest = path.join(outputDir, "AskDemo.mp4");
  if (mp4Path !== dest) {
    await rename(mp4Path, dest);
  }
  await removeFileIfExists(videoPath);
  console.log(`Demo video written to ${dest}`);
}

record().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});