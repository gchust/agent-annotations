import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const evidenceRoot = process.env.AGENT_ANNOTATIONS_EVIDENCE;
const extensionSource = path.resolve("src/demo-extension.ts");
const cli = (...args: string[]) => execFileSync("pnpm", ["exec", "agent-annotations", ...args], {
  encoding: "utf8",
  env: { ...process.env, AGENT_ANNOTATIONS_DIR: runtimeRoot },
});
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);

test("packed browser to file to CLI to browser loop, HMR and session security", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("#agent-annotations-root")).toHaveCount(1);
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect(shadow(page, '[data-action-id="demo.extension:demo-copy-json"]')).toHaveCount(1);
  expect(await page.evaluate(() => window.__demoExtension?.setupCount)).toBe(1);
  expect(statSync(path.join(runtimeRoot, "session.json")).mode & 0o777).toBe(0o600);
  const session = JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8"));
  expect(session.token).toMatch(/^[0-9a-f]{64}$/);

  await shadow(page, 'button[aria-label^="Pick"]').click();
  await page.locator("#target").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Make target purple");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(1);
  // The annotation is persisted before the background screenshot finishes; wait for the
  // composer to close so focus leaves the shadow host before pressing the shortcut.
  await expect(shadow(page, ".aa-composer")).toHaveCount(0);
  // Evidence is best-effort and written asynchronously after the save: wait for it.
  await expect.poll(
    () => JSON.parse(readFileSync(taskPath, "utf8")).annotations[0]?.evidence?.length ?? 0,
    { timeout: 10_000 }
  ).toBe(1);
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const id = task.annotations[0].annotationId;
  expect(task.annotations[0].extensions).toEqual({
    "demo.extension": {
      "demo.extension:target-context": { demoKind: "packed", kept: "visible" },
    },
  });
  // Evidence is listed by the CLI with annotation metadata.
  const evidenceRef = task.annotations[0].evidence.at(-1).ref;
  expect(JSON.parse(cli("evidence", "--json"))[0]).toMatchObject({
    ref: evidenceRef,
    annotationIds: [id],
  });
  // Browser diagnostics persist and clear through the CLI.
  await page.evaluate(() => { console.error("e2e-diagnostic-sentinel"); });
  await expect.poll(() => cli("diagnostics", "--json")).toContain("e2e-diagnostic-sentinel");
  cli("diagnostics", "--clear");
  expect(JSON.parse(cli("diagnostics", "--json"))).toEqual([]);
  // Revision and wait commands report and poll exact referenced sources.
  const revision = JSON.parse(cli("revision", "--json"));
  expect(revision).toMatchObject({ taskRevision: expect.any(Number), sourceFiles: ["src/main.tsx"] });
  expect(revision.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
  // The given revision is a baseline: an unchanged revision times out with changed: false.
  expect(JSON.parse(cli("wait", "--source-revision", revision.sourceRevision, "--timeout-ms", "0", "--json")))
    .toEqual({ changed: false, sourceRevision: revision.sourceRevision });
  expect(JSON.parse(cli("list", "--json"))).toMatchObject({
    taskId: task.taskId,
    taskRevision: expect.any(Number),
  });
  expect(JSON.parse(cli("validate-task", "--json"))).toMatchObject({ ok: true, taskId: task.taskId });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Control+Alt+KeyJ");
  await expect.poll(() => page.evaluate(() => window.__demoExtension?.actionCount)).toBe(1);
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())))
    .toMatchObject({ format: "demo-json" });
  expect(cli("list")).toContain(id);
  expect(cli("print", "--markdown")).toContain("Make target purple");
  const beforeComplete = JSON.parse(cli("validate-task", "--json")).taskRevision;
  expect(cli("complete", id, "--verified", "--summary", "Playwright verified")).toContain(`taskRevision ${beforeComplete + 1}`);
  await expect.poll(() => page.evaluate(() =>
    window.__demoExtension?.studio?.getSnapshot().task.annotations[0]?.status
  )).toBe("completed");
  await expect(shadow(page, '[aria-label="Annotation 1: edit"]')).toHaveCount(0);
  expect(JSON.parse(cli("validate-task", "--json"))).toMatchObject({ ok: true, taskRevision: beforeComplete + 1 });
  expect(cli("reopen", id)).toContain(`taskRevision ${beforeComplete + 2}`);
  await expect.poll(() => page.evaluate(() =>
    document.getElementById("agent-annotations-root")?.shadowRoot
      ?.querySelector('[aria-label="Annotation 1: edit"]')?.getAttribute("data-status")
  )).toBe("open");

  if (evidenceRoot) await page.screenshot({ path: path.join(evidenceRoot, "vertical-loop.png") });
  const token = session.token;
  await page.reload();
  await expect(page.locator("#agent-annotations-root")).toHaveCount(1);
  expect(JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8")).token).toBe(token);
  const source = extensionSource;
  const before = readFileSync(source, "utf8");
  try {
    writeFileSync(source, `${before}\n`);
    await expect.poll(() => page.evaluate(() => ({
      setup: window.__demoExtension?.setupCount,
      dispose: window.__demoExtension?.disposeCount,
      buttons: document.getElementById("agent-annotations-root")?.shadowRoot
        ?.querySelectorAll('[data-action-id="demo.extension:demo-copy-json"]').length,
    }))).toEqual({ setup: 2, dispose: 1, buttons: 1 });
    const beforeAction = await page.evaluate(() => window.__demoExtension?.actionCount);
    await page.keyboard.press("Control+Alt+KeyJ");
    await expect.poll(() => page.evaluate(() => window.__demoExtension?.actionCount))
      .toBe((beforeAction ?? 0) + 1);
  } finally {
    writeFileSync(source, before);
  }
  await expect(page.locator("#agent-annotations-root")).toHaveCount(1);
});
