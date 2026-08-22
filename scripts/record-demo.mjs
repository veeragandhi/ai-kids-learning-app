import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.DEMO_BASE_URL || "http://localhost:3000";
const outputDir = path.resolve("artifacts/demo-video");

const responses = {
  documents: [{ name: "plants.txt", approved: true }],
  upload: { message: "Document uploaded and prepared for learning." },
  lesson: {
    lesson:
      "Plants need water, sunlight, air, and nutrients from the soil to grow well. Sunlight gives plants energy to make food, while water travels from the roots through the plant. A seed contains a tiny baby plant and stored food. When it gets enough water, the seed coat softens and germination begins. First, a root grows down into the soil. Then a shoot grows up toward the light, and leaves open to make food. Imagine two identical seeds: one near a sunny window and one in a dark cupboard. What do you predict will happen?",
  },
  quiz: {
    quiz: JSON.stringify([
      {
        question: "What do plants need to grow?",
        options: ["Water, sunlight, and air", "Rocks and fire", "Only moonlight"],
        answer: "Water, sunlight, and air",
      },
      {
        question: "Which part takes in water from the soil?",
        options: ["The roots", "The flower", "The fruit"],
        answer: "The roots",
      },
    ]),
  },
  guidingQuestion: {
    type: "guidingQuestion",
    question: "What do you think will happen? Why?",
    questionType: "guided",
  },
  feedback: {
    type: "answerEvaluation",
    correctness: "correct",
    feedback: "That's an interesting idea! Your answer connects to the sunlight clue in the document.",
    nextPrompt: "What could we do with two plants to test whether sunlight really makes a difference?",
  },
  explanationFeedback: {
    type: "explanationFeedback",
    score: 90,
    feedback: "Excellent explanation! You used the sunlight clue from the document to support your prediction.",
    finalPrompt: "What would you change in the two-plant test?",
  },
};

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function installDemoRoutes(page) {
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: responses.documents });
      return;
    }
    await route.fulfill({ json: responses.documents });
  });

  await page.route("**/api/upload", (route) =>
    route.fulfill({ json: responses.upload }),
  );
  await page.route("**/api/lesson", (route) =>
    route.fulfill({ json: responses.lesson }),
  );
  await page.route("**/api/quiz", (route) =>
    route.fulfill({ json: responses.quiz }),
  );
  await page.route("**/api/ask", async (route) => {
    const body = route.request().postDataJSON();
    const response = body?.mode === "explanation"
      ? responses.explanationFeedback
      : body?.mode === "answer"
        ? responses.feedback
        : responses.guidingQuestion;
    await route.fulfill({ json: response });
  });
}

async function show(page, selector, milliseconds = 2200) {
  await page.locator(selector).scrollIntoViewIfNeeded().catch(() => {});
  await pause(milliseconds);
}

async function record() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  await installDemoRoutes(page);

  await page.goto(baseUrl);
  await show(page, "text=Meet AmigosNest!", 1800);

  await page.goto(`${baseUrl}/upload`);
  await show(page, "text=Upload Learning Material");
  await page.locator('input[type="file"]').setInputFiles("C:/Users/veera/OneDrive/Desktop/plants.txt");
  await page.getByRole("button", { name: "Upload Document" }).click();
  await show(page, "text=Document uploaded and prepared for learning.");

  await page.goto(`${baseUrl}/lesson?topic=plants`);
  await show(page, "text=AI Learning Adventure");
  await page.getByRole("button", { name: "Start Adventure" }).click();
  await show(page, "text=Your AI Lesson", 3200);
  await page.mouse.wheel(0, 560);
  await pause(1800);
  await page.mouse.wheel(0, 560);
  await pause(1800);
  await page.mouse.wheel(0, -1120);
  await pause(1200);

  await page.goto(`${baseUrl}/quiz`);
  await page.getByPlaceholder("Choose a quiz topic...").fill("Plants");
  await pause(1800);
  await page.getByRole("button", { name: "Start Quiz" }).click();
  await show(page, "text=Quiz Progress", 4200);
  await page.getByRole("button", { name: "Water, sunlight, and air" }).click();
  await pause(2200);
  await page.getByRole("button", { name: "The roots" }).click();
  await pause(2200);
  await page.getByRole("button", { name: "Submit Answers" }).click();
  await show(page, "text=Amazing Work!", 5000);

  await page.goto(`${baseUrl}/ask`);
  await page.locator("textarea").first().fill("If I give a plant water but put it in a dark cupboard, will it still grow?");
  await pause(2200);
  await page.getByRole("button", { name: "Get a guiding question" }).click();
  await show(page, "text=Guiding Question", 5000);
  await page.getByPlaceholder("Write your answer here...").fill("I think it won't grow properly because it needs sunlight.");
  await pause(3000);
  await page.getByRole("button", { name: "Submit answer" }).click();
  await show(page, "text=Feedback", 6500);
  await page.locator('textarea[placeholder="Explain how you knew your answer."]').fill("The document says sunlight gives plants energy to make food, so the dark cupboard may stop it growing properly.");
  await pause(3000);
  await page.getByRole("button", { name: "Submit explanation" }).click();
  await show(page, "text=Explanation Feedback", 7000);

  await context.close();
  await browser.close();
  console.log(`Demo video written to ${path.join(outputDir, "*.webm")}`);
}

record().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});