import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const shadow = (page: Page, selector: string) => page.locator(`#agent-annotations-root >> ${selector}`);
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

const rows = (task: any) => task.annotations.map((annotation: any) => {
  const source = annotation.targets[0].inspection.source;
  return {
    selector: annotation.targets[0].selector,
    filePath: source?.filePath ?? null,
    lineNumber: source?.lineNumber ?? null,
    columnNumber: source?.columnNumber ?? null,
  };
});

const revision = async (page: Page, token: string) => page.evaluate(async (value) => {
  const session = await (await fetch("/__agent-annotations/revision", {
    headers: { "x-agent-annotations-token": value },
  })).json();
  return session;
}, token);

const capture = async (page: Page, selector: string) => {
  const comment = `source ${selector}`;
  const expectedCount = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length + 1;
  await page.keyboard.press("Control+Alt+P");
  await page.locator(selector).click();
  await shadow(page, '[aria-label="Annotation comment"]').fill(comment);
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  // The save handler persists asynchronously (an add mutation followed by
  // best-effort screenshot evidence). Instead of a fixed delay, wait for an
  // observable state: the task file must reach the expected annotation count
  // and already carry this annotation's comment and target selector.
  await expect.poll(() => {
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    const annotation = task.annotations.find((entry: any) => entry.comment === comment);
    return task.annotations.length === expectedCount
      && annotation?.targets?.[0]?.selector.includes(selector.slice(1)) === true;
  }, { timeout: 10_000, message: `annotation ${selector} was not persisted` }).toBe(true);
  // Evidence is written asynchronously after the save; waiting for it drains
  // the server write queue so the later manual rewrite of the task file can
  // never be overwritten by a late evidence mutation.
  await expect.poll(() => {
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    const annotation = task.annotations.find((entry: any) => entry.comment === comment);
    return (annotation?.evidence?.length ?? 0) >= 1;
  }, { timeout: 10_000, message: `evidence for ${selector} was not persisted` }).toBe(true);
};

test("source-benchmark duplicate-basename exact path, line, column, and revision", async ({ page }) => {
  await page.goto("/");
  await page.locator("#portal-toggle").click();
  for (const selector of Object.keys(expected)) await capture(page, selector);

  // The final save must be fully drained before the task file is read again:
  // wait until every expected annotation is visible on disk with its exact
  // source path/line/column, and until the composer closes (the runtime writes
  // best-effort screenshot evidence after every save, which mutates the file).
  await expect.poll(() => {
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    if (task.annotations.length !== Object.keys(expected).length) return false;
    return Object.entries(expected).every(([selector, source]) => {
      const row = rows(task).find((entry: any) => entry.selector.includes(selector.slice(1)));
      return row !== undefined
        && row.filePath === source.filePath
        && row.lineNumber === source.lineNumber
        && row.columnNumber === source.columnNumber;
    });
  }, { timeout: 10_000, message: "expected annotations are not all persisted with exact source info" }).toBe(true);
  await expect(shadow(page, ".aa-composer")).toHaveCount(0);

  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const actual = rows(task);
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
  expect(baseline.referencedSourceFiles).toContain("src/duplicate-a/Card.tsx");
  expect(baseline.referencedSourceFiles).not.toContain("src/duplicate-b/Card.tsx");
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
      referencedSourceFiles: baseline.referencedSourceFiles,
    });
    expect(afterCorrect.referencedSourceRevision).not.toBe(baseline.referencedSourceRevision);
    console.log(`source-revision baseline=${JSON.stringify(baseline)} afterWrong=${JSON.stringify(afterWrong)} afterCorrect=${JSON.stringify(afterCorrect)}`);
  } finally {
    writeFileSync(wrong, wrongBefore);
    writeFileSync(correct, correctBefore);
  }
});
