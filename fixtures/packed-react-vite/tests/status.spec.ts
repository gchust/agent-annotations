import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);
const cli = (...args: string[]) => execFileSync("pnpm", ["exec", "agent-annotations", ...args], {
  encoding: "utf8",
  env: { ...process.env, AGENT_ANNOTATIONS_DIR: runtimeRoot },
});
const statusJson = () => JSON.parse(cli("status", "--json"));
const card = path.resolve("src/duplicate-a/Card.tsx");
const extension = path.resolve("src/demo-extension.ts");

test("browser status health and HMR-applied source revision ordering", async ({ page }) => {
  await page.goto("/");
  // Capture an annotation whose source is a component file that hot-updates.
  await page.keyboard.press("Control+Alt+P");
  await page.locator("#duplicate-a").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Status fixture");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  // The annotation introduces its first referenced source. A full reload is
  // the trusted update that establishes the corresponding source snapshot.
  await page.reload();

  // Propagation is asynchronous (heartbeats every 5s): poll the full health
  // contract instead of assuming the latest save is already reported.
  await expect.poll(async () => {
    const status = statusJson();
    return status.browserConnected && status.taskSynchronized && status.sourceSynchronized
      ? status
      : null;
  }, { timeout: 15_000 }).not.toBeNull();
  const healthy = JSON.parse(cli("status", "--check", "--json"));
  expect(healthy).toMatchObject({
    taskValid: true,
    browserConnected: true,
    taskSynchronized: true,
    sourceSynchronized: true,
  });
  expect(healthy.browserUpdateRevision).toBe(1);
  expect(healthy.referencedSourceRevision).toMatch(/^[0-9a-f]{64}$/);

  // Navigate with an ordinary secret query: the route key never persists it.
  await page.goto("/?secret=supersecretquery");
  await expect.poll(() => statusJson().routeKey, { timeout: 15_000 }).toBe("/");
  const diskState = JSON.parse(readFileSync(path.join(runtimeRoot, "browser-state.json"), "utf8"));
  expect(diskState.routeKey).not.toContain("secret");
  expect(JSON.stringify(diskState)).not.toContain("supersecretquery");
  await expect.poll(async () => {
    const status = statusJson();
    return status.browserConnected && status.taskSynchronized && status.sourceSynchronized
      ? status
      : null;
  }, { timeout: 15_000 }).not.toBeNull();

  const baselineStatus = statusJson();
  const baseline = baselineStatus.referencedSourceRevision;
  const baselineGeneration = baselineStatus.browserUpdateRevision;
  const before = readFileSync(card, "utf8");
  try {
    // A transform error keeps the old module running. Completing the task is
    // task-only work and cannot advance either browser-applied field.
    writeFileSync(card, `${before}\nexport const broken = ;\n`);
    await page.locator("vite-error-overlay").waitFor();
    const failedBaseline = statusJson();
    expect(failedBaseline.browserUpdateRevision).toBe(baselineGeneration);
    expect(failedBaseline.referencedSourceRevision).toBe(baseline);
    const task = JSON.parse(readFileSync(path.join(runtimeRoot, "tasks/active-task.json"), "utf8"));
    cli("complete", task.annotations[0].annotationId, "--verified", "--summary", "Failed HMR remains unapplied");
    await expect.poll(() => statusJson().taskSynchronized, { timeout: 15_000 }).toBe(true);
    const failedUpdate = statusJson();
    expect(failedUpdate.browserUpdateRevision).toBe(failedBaseline.browserUpdateRevision);
    expect(failedUpdate.referencedSourceRevision).toBe(failedBaseline.referencedSourceRevision);

    // Modify the rendered Card content: the browser must report the new
    // revision only after the HMR update is actually applied, and the live
    // DOM must show the new value once the browser-source wait returns.
    const next = before.replace("Duplicate A</button>", "Duplicate A APPLIED</button>");
    writeFileSync(card, next);
    const waited = JSON.parse(cli(
      "wait", "--browser-source-revision", baseline, "--timeout-ms", "15000", "--json"
    ));
    expect(waited).toMatchObject({ changed: true });
    expect(waited.sourceRevision).not.toBe(baseline);
    // Immediate read (no auto-wait): the DOM must already show the new value
    // at the moment the browser-source wait returned, proving the report
    // happened after the HMR update actually applied.
    const text = await page.locator("#duplicate-a").evaluate((element) => element.textContent);
    expect(text).toBe("Duplicate A APPLIED");
    // After the HMR applied, the disk and browser revisions agree again.
    const applied = JSON.parse(cli("status", "--check", "--json"));
    expect(applied.sourceSynchronized).toBe(true);
    expect(applied.browserUpdateRevision).toBe(failedBaseline.browserUpdateRevision + 1);
    expect(applied.referencedSourceRevision).toBe(statusJson().sourceRevision);
    // An unrelated module's HMR update is visibly applied (the extension
    // re-setups) but never moves the referenced-source applied revision.
    const appliedRevision = applied.referencedSourceRevision;
    const extensionBefore = readFileSync(extension, "utf8");
    const setupBefore = await page.evaluate(() =>
      (window as { __demoExtension?: { setupCount?: number } }).__demoExtension?.setupCount ?? 0
    );
    writeFileSync(extension, `${extensionBefore}\n`);
    await expect.poll(() => page.evaluate(() =>
      (window as { __demoExtension?: { setupCount?: number } }).__demoExtension?.setupCount ?? 0
    ), { timeout: 15_000 }).toBeGreaterThan(setupBefore);
    await expect.poll(() => statusJson().referencedSourceRevision, { timeout: 15_000 })
      .toBe(appliedRevision);
    writeFileSync(extension, extensionBefore);
  } finally {
    writeFileSync(card, before);
  }
});
