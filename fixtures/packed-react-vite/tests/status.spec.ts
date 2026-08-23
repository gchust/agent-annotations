import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);
const cli = (...args: string[]) => execFileSync("pnpm", ["exec", "agent-annotations", ...args], {
  encoding: "utf8",
  env: { ...process.env, AGENT_ANNOTATIONS_DIR: runtimeRoot },
});
const statusJson = () => JSON.parse(cli("status", "--json"));
const card = path.resolve("src/duplicate-a/Card.tsx");
const extension = path.resolve("src/demo-extension.ts");
const ordersSource = path.resolve("src/route-b/RouteB.tsx");

test("keeps two browser runtimes isolated through HMR and page close", async ({ page, context }) => {
  const orders = await context.newPage();
  await page.routeWebSocket(/.*/, (socket) => socket.close());
  await page.goto("/customers");
  await orders.goto("/orders");
  const runtime = async (routeKey: string) => {
    const report = statusJson();
    return report.runtimes.find((entry: { routeKey: string }) => entry.routeKey === routeKey) ?? null;
  };
  await expect.poll(() => runtime("/customers"), { timeout: 15_000 }).not.toBeNull();
  await expect.poll(() => runtime("/orders"), { timeout: 15_000 }).not.toBeNull();
  const customersRuntime = await runtime("/customers");
  const ordersRuntime = await runtime("/orders");
  expect(customersRuntime.runtimeId).not.toBe(ordersRuntime.runtimeId);
  expect(statusJson()).toMatchObject({
    selectedRuntimeId: null,
    runtimeSelectionError: "ambiguous_browser_runtime",
  });

  const before = readFileSync(ordersSource, "utf8");
  try {
    writeFileSync(ordersSource, before.replace("Route B</h1>", "Route B UPDATED</h1>"));
    const waited = JSON.parse(cli(
      "wait", "--browser-update-revision", String(ordersRuntime.browserUpdateRevision),
      "--runtime", ordersRuntime.runtimeId, "--timeout-ms", "15000", "--json"
    ));
    expect(waited.changed).toBe(true);
    await expect(orders.locator("h1")).toHaveText("Route B UPDATED");
    expect(JSON.parse(cli(
      "wait", "--browser-update-revision", String(customersRuntime.browserUpdateRevision),
      "--runtime", customersRuntime.runtimeId, "--timeout-ms", "0", "--json"
    ))).toEqual({
      changed: false,
      browserConnected: true,
      browserUpdateRevision: customersRuntime.browserUpdateRevision,
    });
  } finally {
    writeFileSync(ordersSource, before);
  }

  await page.close();
  const customersStatePath = path.join(runtimeRoot, "browser-states", `${customersRuntime.runtimeId}.json`);
  expect(existsSync(customersStatePath)).toBe(true);
  expect(await runtime("/orders")).toMatchObject({ runtimeId: ordersRuntime.runtimeId });
  await orders.close();
  rmSync(customersStatePath, { force: true });
  rmSync(path.join(runtimeRoot, "browser-states", `${ordersRuntime.runtimeId}.json`), { force: true });
});

test("browser status health and HMR-applied source revision ordering", async ({ page }) => {
  await page.goto("/");
  // Capture an annotation whose source is a component file that hot-updates.
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect.poll(() => statusJson().selectedRuntimeId, { timeout: 15_000 }).not.toBeNull();
  const initialStatus = statusJson();
  const initialAnnotations = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length;
  await page.keyboard.press("Control+Alt+P");
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#duplicate-a").click();
  await expect(shadow(page, '[aria-label="Annotation comment"]')).toBeVisible();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Status fixture");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(initialAnnotations + 1);
  // The annotation introduces its first referenced source. A full reload is
  // the trusted update that establishes the corresponding source snapshot.
  await page.reload();
  await expect(shadow(page, ".aa-dock")).toBeVisible();

  // Propagation is asynchronous (heartbeats every 5s): poll the full health
  // contract instead of assuming the latest save is already reported.
  await expect.poll(async () => {
    const status = statusJson();
    return status.browserConnected && status.taskSynchronized && status.referencedSourceSynchronized
      ? status
      : null;
  }, { timeout: 15_000 }).not.toBeNull();
  const healthy = JSON.parse(cli("status", "--check", "--json"));
  expect(healthy).toMatchObject({
    taskValid: true,
    browserConnected: true,
    taskSynchronized: true,
    referencedSourceSynchronized: true,
  });
  expect(healthy.selectedRuntimeId).toBe(initialStatus.selectedRuntimeId);
  expect(healthy.browserUpdateRevision).toBeGreaterThan(initialStatus.browserUpdateRevision);
  expect(healthy.browserReferencedSourceRevision).toMatch(/^[0-9a-f]{64}$/);

  // Navigate with an ordinary secret query: the route key never persists it.
  await page.goto("/?secret=supersecretquery");
  await expect.poll(() => statusJson().routeKey, { timeout: 15_000 }).toBe("/");
  const runtimeId = statusJson().selectedRuntimeId;
  const diskState = JSON.parse(readFileSync(path.join(runtimeRoot, "browser-states", `${runtimeId}.json`), "utf8"));
  expect(diskState.routeKey).not.toContain("secret");
  expect(JSON.stringify(diskState)).not.toContain("supersecretquery");
  await expect.poll(async () => {
    const status = statusJson();
    return status.browserConnected && status.taskSynchronized && status.referencedSourceSynchronized
      ? status
      : null;
  }, { timeout: 15_000 }).not.toBeNull();

  const baselineStatus = statusJson();
  const baseline = baselineStatus.browserReferencedSourceRevision;
  const baselineGeneration = baselineStatus.browserUpdateRevision;
  const before = readFileSync(card, "utf8");
  try {
    // A transform error keeps the old module running. Completing the task is
    // task-only work and cannot advance either browser-applied field.
    writeFileSync(card, `${before}\nexport const broken = ;\n`);
    await page.locator("vite-error-overlay").waitFor();
    const failedBaseline = statusJson();
    expect(failedBaseline.browserUpdateRevision).toBe(baselineGeneration);
    expect(failedBaseline.browserReferencedSourceRevision).toBe(baseline);
    const task = JSON.parse(readFileSync(path.join(runtimeRoot, "tasks/active-task.json"), "utf8"));
    cli("complete", task.annotations[0].annotationId, "--verified", "--summary", "Failed HMR remains unapplied");
    await expect.poll(() => statusJson().taskSynchronized, { timeout: 15_000 }).toBe(true);
    const failedUpdate = statusJson();
    expect(failedUpdate.browserUpdateRevision).toBe(failedBaseline.browserUpdateRevision);
    expect(failedUpdate.browserReferencedSourceRevision).toBe(failedBaseline.browserReferencedSourceRevision);

    // Modify the rendered Card content: the browser must report the new
    // revision only after the HMR update is actually applied, and the live
    // DOM must show the new value once the browser-update wait returns.
    const next = before.replace("Duplicate A</button>", "Duplicate A APPLIED</button>");
    writeFileSync(card, next);
    const waited = JSON.parse(cli(
      "wait", "--browser-update-revision", String(baselineGeneration), "--runtime", runtimeId, "--timeout-ms", "15000", "--json"
    ));
    expect(waited).toMatchObject({ changed: true });
    expect(waited.browserUpdateRevision).toBeGreaterThan(baselineGeneration);
    // Immediate read (no auto-wait): the DOM must already show the new value
    // at the moment the browser-update wait returned, proving the report
    // happened after the HMR update actually applied.
    const text = await page.locator("#duplicate-a").evaluate((element) => element.textContent);
    expect(text).toBe("Duplicate A APPLIED");
    // After the HMR applied, the disk and browser revisions agree again.
    const applied = JSON.parse(cli("status", "--check", "--json"));
    expect(applied.referencedSourceSynchronized).toBe(true);
    expect(applied.browserUpdateRevision).toBe(failedBaseline.browserUpdateRevision + 1);
    expect(applied.browserReferencedSourceRevision).toBe(statusJson().referencedSourceRevision);
    // An unrelated module's HMR update is visibly applied (the extension
    // re-setups) but never moves the referenced-source applied revision.
    const appliedRevision = applied.browserReferencedSourceRevision;
    const extensionBefore = readFileSync(extension, "utf8");
    const setupBefore = await page.evaluate(() =>
      (window as { __demoExtension?: { setupCount?: number } }).__demoExtension?.setupCount ?? 0
    );
    writeFileSync(extension, `${extensionBefore}\n`);
    await expect.poll(() => page.evaluate(() =>
      (window as { __demoExtension?: { setupCount?: number } }).__demoExtension?.setupCount ?? 0
    ), { timeout: 15_000 }).toBeGreaterThan(setupBefore);
    await expect.poll(() => JSON.parse(cli("status", "--runtime", runtimeId, "--json")), { timeout: 15_000 })
      .toMatchObject({ selectedRuntimeId: runtimeId, browserConnected: true });
    await expect.poll(() => JSON.parse(cli("status", "--runtime", runtimeId, "--json")).browserUpdateRevision, {
      timeout: 15_000,
    }).toBeGreaterThan(applied.browserUpdateRevision);
    await expect.poll(() => statusJson().browserReferencedSourceRevision, { timeout: 15_000 })
      .toBe(appliedRevision);
    const setupAfterChange = await page.evaluate(() =>
      (window as { __demoExtension?: { setupCount?: number } }).__demoExtension?.setupCount ?? 0
    );
    writeFileSync(extension, extensionBefore);
    await expect.poll(() => page.evaluate(() =>
      (window as { __demoExtension?: { setupCount?: number } }).__demoExtension?.setupCount ?? 0
    ), { timeout: 15_000 }).toBeGreaterThan(setupAfterChange);
    await expect.poll(() => statusJson().referencedSourceSynchronized, { timeout: 15_000 }).toBe(true);

    const theme = path.resolve("src/theme.css");
    const themeBefore = readFileSync(theme, "utf8");
    try {
      const cssGeneration = statusJson().browserUpdateRevision;
      const cssBefore = await page.locator("#target").evaluate((element) => ({
        color: getComputedStyle(element).outlineColor,
        width: getComputedStyle(element).outlineWidth,
      }));
      writeFileSync(theme, `${themeBefore}\n#target { outline-color: rgb(220, 40, 40); outline-width: 4px; }\n`);
      const cssWait = JSON.parse(cli(
        "wait", "--browser-update-revision", String(cssGeneration), "--runtime", runtimeId, "--timeout-ms", "15000", "--json"
      ));
      expect(cssWait.changed).toBe(true);
      expect(cssWait.browserUpdateRevision).toBeGreaterThan(cssGeneration);
      await expect.poll(() => page.locator("#target").evaluate((element) => ({
        color: getComputedStyle(element).outlineColor,
        width: getComputedStyle(element).outlineWidth,
      }))).not.toEqual(cssBefore);
      expect(statusJson().browserReferencedSourceRevision).toBe(appliedRevision);
    } finally {
      writeFileSync(theme, themeBefore);
    }
  } finally {
    writeFileSync(card, before);
  }
  await page.close();
  rmSync(path.join(runtimeRoot, "browser-states", `${runtimeId}.json`), { force: true });
});

test("pinned runtime wait survives reload and tabs keep distinct sessions", async ({ page, context }) => {
  await page.goto("/customers");
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect.poll(() => statusJson().runtimes.find((entry: { routeKey: string }) =>
    entry.routeKey === "/customers"), { timeout: 15_000 }).not.toBeNull();
  const before = statusJson().runtimes.find((entry: { routeKey: string }) =>
    entry.routeKey === "/customers");
  const statePath = path.join(runtimeRoot, "browser-states", `${before.runtimeId}.json`);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  writeFileSync(statePath, "{invalid");
  const child = spawn(process.execPath, [
    path.resolve("node_modules/@gchust/agent-annotations/dist/cli/index.mjs"), "wait",
    "--browser-update-revision", String(before.browserUpdateRevision + 1),
    "--runtime", before.runtimeId,
    "--timeout-ms", "15000",
    "--json",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_ANNOTATIONS_DIR: runtimeRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  await expect.poll(() => existsSync(statePath), { timeout: 5_000 }).toBe(false);
  expect(child.exitCode).toBeNull();
  await page.reload();
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect.poll(() => JSON.parse(cli("status", "--runtime", before.runtimeId, "--json")).browserUpdateRevision, {
    timeout: 15_000,
  }).toBeGreaterThan(before.browserUpdateRevision);
  const afterReload = JSON.parse(cli("status", "--runtime", before.runtimeId, "--json"));
  expect(afterReload.selectedRuntimeId).toBe(before.runtimeId);
  expect(child.exitCode).toBeNull();
  const routeSource = path.resolve("src/route-a/RouteA.tsx");
  const routeBefore = readFileSync(routeSource, "utf8");
  try {
    writeFileSync(routeSource, routeBefore.replace("Route A</h1>", "Route A RELOADED</h1>"));
    await expect(page.locator("h1")).toHaveText("Route A RELOADED");
    await expect.poll(() => JSON.parse(
      cli("status", "--runtime", before.runtimeId, "--json")
    ).browserUpdateRevision, { timeout: 15_000 }).toBeGreaterThan(afterReload.browserUpdateRevision);
  } finally {
    writeFileSync(routeSource, routeBefore);
  }
  expect(await closed).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const waited = JSON.parse(stdout);
  expect(waited).toMatchObject({ changed: true, browserConnected: true });
  expect(waited.browserUpdateRevision).toBeGreaterThan(before.browserUpdateRevision + 1);
  const reloaded = JSON.parse(cli("status", "--runtime", before.runtimeId, "--json"));
  expect(reloaded.selectedRuntimeId).toBe(before.runtimeId);
  expect(reloaded.browserUpdateRevision).toBeGreaterThan(before.browserUpdateRevision);

  const second = await context.newPage();
  await second.goto("/orders");
  await expect(shadow(second, ".aa-dock")).toBeVisible();
  await expect.poll(() => statusJson().runtimes.find((entry: { routeKey: string }) =>
    entry.routeKey === "/orders"), { timeout: 15_000 }).not.toBeNull();
  const other = statusJson().runtimes.find((entry: { routeKey: string }) => entry.routeKey === "/orders");
  expect(other.runtimeId).not.toBe(before.runtimeId);
  await second.close();
});
