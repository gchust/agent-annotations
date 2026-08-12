import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-feedback");
const evidenceRoot = process.env.AGENT_FEEDBACK_EVIDENCE;
const cli = (...args: string[]) => execFileSync("pnpm", ["exec", "agent-feedback", ...args], {
  encoding: "utf8",
  env: { ...process.env, AGENT_FEEDBACK_DIR: runtimeRoot },
});
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-feedback-root >> ${selector}`);

test("packed browser to file to CLI to browser loop, HMR and session security", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#agent-feedback-root")).toHaveCount(1);
  await expect(shadow(page, ".af-dock")).toBeVisible();
  expect(statSync(path.join(runtimeRoot, "session.json")).mode & 0o777).toBe(0o600);
  const session = JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8"));
  expect(session.token).toMatch(/^[0-9a-f]{64}$/);

  await shadow(page, 'button[aria-label^="Pick"]').click();
  await page.locator("#target").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Make target purple");
  await shadow(page, 'button:has-text("Save annotation")').click();
  const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(1);
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const id = task.annotations[0].annotationId;
  expect(cli("list")).toContain(id);
  expect(cli("print", "--markdown")).toContain("Make target purple");
  expect(cli("complete", id, "--verified", "--summary", "Playwright verified")).toContain("taskRevision 2");
  await expect.poll(() => page.evaluate(() =>
    document.getElementById("agent-feedback-root")?.shadowRoot
      ?.querySelector('[aria-label="Annotation 1: edit"]')?.getAttribute("data-status")
  )).toBe("completed");
  expect(JSON.parse(cli("verify"))).toMatchObject({ ok: true, taskRevision: 2 });
  expect(cli("reopen", id)).toContain("taskRevision 3");
  await expect.poll(() => page.evaluate(() =>
    document.getElementById("agent-feedback-root")?.shadowRoot
      ?.querySelector('[aria-label="Annotation 1: edit"]')?.getAttribute("data-status")
  )).toBe("open");

  if (evidenceRoot) await page.screenshot({ path: path.join(evidenceRoot, "vertical-loop.png") });
  const token = session.token;
  await page.reload();
  await expect(page.locator("#agent-feedback-root")).toHaveCount(1);
  expect(JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8")).token).toBe(token);
  const source = path.resolve("src/main.tsx");
  const before = readFileSync(source, "utf8");
  try {
    writeFileSync(source, before.replace("Target button", "Target button HMR"));
    await expect(page.locator("#target")).toHaveText("Target button HMR");
  } finally {
    writeFileSync(source, before);
  }
  await expect(page.locator("#agent-feedback-root")).toHaveCount(1);
});
