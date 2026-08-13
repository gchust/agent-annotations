import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-feedback");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const shadow = (page: Page, selector: string) => page.locator(`#agent-feedback-root >> ${selector}`);
const position = (filePath: string, marker: string) => {
  const lines = readFileSync(path.resolve(filePath), "utf8").split("\n");
  const line = lines.findIndex((value) => value.includes(marker));
  return { filePath, lineNumber: line + 1, columnNumber: lines[line]!.indexOf(marker) + 1 };
};
const expected = {
  "#duplicate-a": position("src/duplicate-a/Card.tsx", '<button id="duplicate-a"'),
  "#duplicate-b": position("src/duplicate-b/Card.tsx", '<button id="duplicate-b"'),
  "#memo-card": position("src/main.tsx", '<button id="memo-card"'),
  "#forward-card": position("src/main.tsx", '<button id="forward-card"'),
  "#portal-target": position("src/main.tsx", '<button id="portal-target"'),
} as const;

const capture = async (page: Page, selector: string) => {
  await shadow(page, 'button[aria-label^="Pick"]').click();
  await page.locator(selector).click();
  await shadow(page, '[aria-label="Annotation comment"]').fill(`source ${selector}`);
  await shadow(page, 'button:has-text("Save annotation")').click();
};

const revision = async (page: Page, token: string) => page.evaluate(async (value) => {
  const session = await (await fetch("/__agent-feedback/revision", {
    headers: { "x-agent-feedback-token": value },
  })).json();
  return session;
}, token);

test("source-benchmark duplicate-basename exact path, line, column, and revision", async ({ page }) => {
  await page.goto("/");
  await page.locator("#portal-toggle").click();
  for (const selector of Object.keys(expected)) await capture(page, selector);

  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const actual = task.annotations.map((annotation: any) => {
    const source = annotation.targets[0].inspection.source;
    return {
      selector: annotation.targets[0].selector,
      filePath: source?.filePath ?? null,
      lineNumber: source?.lineNumber ?? null,
      columnNumber: source?.columnNumber ?? null,
    };
  });
  for (const [selector, source] of Object.entries(expected)) {
    const row = actual.find((entry: any) => entry.selector.includes(selector.slice(1)));
    expect(row, `${selector} expected=${JSON.stringify(source)} actual=${JSON.stringify(row)}`).toMatchObject(source);
  }
  console.log(`duplicate-basename expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);

  const selected = task.annotations.find((annotation: any) =>
    annotation.targets[0].selector.includes("duplicate-a")
  );
  writeFileSync(taskPath, `${JSON.stringify({
    ...task,
    taskRevision: task.taskRevision + 1,
    updatedAt: new Date().toISOString(),
    annotations: [selected],
  }, null, 2)}\n`);
  const correct = path.resolve("src/duplicate-a/Card.tsx");
  const wrong = path.resolve("src/duplicate-b/Card.tsx");
  const token = JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8")).token;
  const baseline = await revision(page, token);
  expect(baseline.sourceFiles).toContain("src/duplicate-a/Card.tsx");
  expect(baseline.sourceFiles).not.toContain("src/duplicate-b/Card.tsx");
  const wrongBefore = readFileSync(wrong, "utf8");
  const correctBefore = readFileSync(correct, "utf8");
  try {
    writeFileSync(wrong, `${wrongBefore}\n`);
    const afterWrong = await revision(page, token);
    expect(afterWrong).toEqual(baseline);
    writeFileSync(correct, `${correctBefore}\n`);
    const afterCorrect = await revision(page, token);
    expect(afterCorrect).toMatchObject({
      taskRevision: baseline.taskRevision,
      sourceFiles: baseline.sourceFiles,
    });
    expect(afterCorrect.sourceRevision).not.toBe(baseline.sourceRevision);
    console.log(`source-revision baseline=${JSON.stringify(baseline)} afterWrong=${JSON.stringify(afterWrong)} afterCorrect=${JSON.stringify(afterCorrect)}`);
  } finally {
    writeFileSync(wrong, wrongBefore);
    writeFileSync(correct, correctBefore);
  }
});
