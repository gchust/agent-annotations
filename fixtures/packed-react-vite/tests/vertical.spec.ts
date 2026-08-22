import { execFileSync, spawnSync } from "node:child_process";
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
const cliFailure = (...args: string[]) => spawnSync("pnpm", ["exec", "agent-annotations", ...args], {
  encoding: "utf8",
  env: { ...process.env, AGENT_ANNOTATIONS_DIR: runtimeRoot },
});
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);

test("packed browser to file to CLI to browser loop, HMR and session security", async ({ page, context }) => {
  const privacySentinel = "G03_OAUTH_RESET_SIGNED_URL_SENTINEL";
  await page.goto(`/?code=${privacySentinel}&reset=${privacySentinel}&signedUrl=${privacySentinel}#/customers`);
  await expect(page.locator("#agent-annotations-root")).toHaveCount(1);
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect(shadow(page, '[data-action-id="demo.extension:demo-copy-json"]')).toHaveCount(1);
  expect(await page.evaluate(() => window.__demoExtension?.setupCount)).toBe(1);
  expect(statSync(path.join(runtimeRoot, "session.json")).mode & 0o777).toBe(0o600);
  const session = JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8"));
  expect(session.token).toMatch(/^[0-9a-f]{64}$/);

  await page.keyboard.press("Control+Alt+P");
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
  expect(task.annotations[0].pageContext).toMatchObject({
    url: "http://127.0.0.1:4179/",
    routeKey: "/#/customers",
  });
  expect(JSON.stringify(task)).not.toContain(privacySentinel);
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
  await page.evaluate(async (sentinel) => {
    await fetch(`http://127.0.0.1:1/privacy-probe?code=${sentinel}`).catch(() => undefined);
  }, privacySentinel);
  await expect.poll(() => cli("diagnostics", "--json")).toContain("privacy-probe");
  expect(cli("diagnostics", "--json")).not.toContain(privacySentinel);
  let selectedRuntimeId = JSON.parse(cli("status", "--json")).selectedRuntimeId;
  const browserState = readFileSync(path.join(runtimeRoot, "browser-states", `${selectedRuntimeId}.json`), "utf8");
  expect(JSON.parse(browserState).routeKey).toBe("/#/customers");
  expect(browserState).not.toContain(privacySentinel);
  cli("diagnostics", "--clear");
  expect(JSON.parse(cli("diagnostics", "--json"))).toEqual([]);
  // A host identity adapter can fail for one NocoBase-style record without
  // disabling capture, markers, or Copy. The fault is persisted once.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => { window.__AGENT_ANNOTATIONS_IDENTITY_FAULT = true; });
  await page.keyboard.press("Control+Alt+P");
  await page.locator("#target").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Identity fallback remains usable");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => (JSON.parse(cli("diagnostics", "--json")) as Array<{ contributionId?: string }>)
    .filter((entry) => entry.contributionId === "identity").length).toBe(1);
  expect((JSON.parse(cli("diagnostics", "--json")) as Array<{ contributionId?: string }>)
    .filter((entry) => entry.contributionId === "identity")).toHaveLength(1);
  await expect(shadow(page, ".aa-marker")).toHaveCount(2);
  await page.keyboard.press("Control+Alt+C");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Identity fallback remains usable");
  await page.evaluate(() => { window.__AGENT_ANNOTATIONS_IDENTITY_FAULT = false; });
  // The first referenced source was introduced by task-only capture. Reloading
  // establishes the browser-applied source baseline before exact status checks.
  await page.reload();
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect.poll(() => {
    const status = JSON.parse(cli("status", "--json"));
    return status.browserConnected && status.taskSynchronized && status.referencedSourceSynchronized
      ? status.selectedRuntimeId
      : null;
  }, { timeout: 15_000 }).not.toBeNull();
  selectedRuntimeId = JSON.parse(cli("status", "--json")).selectedRuntimeId;
  // Revision and wait commands report and poll exact referenced sources.
  const revision = JSON.parse(cli("revision", "--json"));
  expect(revision).toMatchObject({ taskRevision: expect.any(Number), referencedSourceFiles: ["src/main.tsx"] });
  expect(revision.referencedSourceRevision).toMatch(/^[0-9a-f]{64}$/);
  // The given revision is a baseline: an unchanged revision times out with changed: false.
  expect(JSON.parse(cli("wait", "--referenced-source-revision", revision.referencedSourceRevision, "--timeout-ms", "0", "--json")))
    .toEqual({ changed: false, referencedSourceRevision: revision.referencedSourceRevision });
  expect(JSON.parse(cli("list", "--json"))).toMatchObject({
    taskId: task.taskId,
    taskRevision: expect.any(Number),
  });
  expect(JSON.parse(cli("validate-task", "--json"))).toMatchObject({ ok: true, taskId: task.taskId });
  await page.keyboard.press("Control+Alt+C");
  const handoff = await page.evaluate(() => navigator.clipboard.readText());
  expect(handoff).toContain("- route: /#/customers");
  expect(handoff).toContain(`--runtime ${selectedRuntimeId}`);
  expect(handoff).toContain(`--annotation ${id}`);
  expect(handoff).toContain("--fail-on-diagnostics --diagnostics-since");
  expect(handoff).toContain("--summary-file agent-annotations-summary-");
  expect(handoff).not.toContain("--summary 'Make target purple'");
  expect(handoff).not.toContain(privacySentinel);

  // The current-route heartbeat follows Goal 06's shared resolution snapshot:
  // even with markers hidden, exact target loss blocks status and restoring
  // the same identity recovers on the bounded periodic heartbeat.
  await page.evaluate(() => window.__demoExtension?.studio?.commands.markers.hide());
  await page.locator("#target").evaluate((element) => {
    const state = window as typeof window & { __GOAL07_TARGET?: Element; __GOAL07_NEXT?: ChildNode | null };
    state.__GOAL07_TARGET = element;
    state.__GOAL07_NEXT = element.nextSibling;
    element.remove();
  });
  await expect.poll(() => {
    const result = cliFailure("status", "--runtime", selectedRuntimeId, "--annotation", id, "--check", "--json");
    return result.status === 1 ? JSON.parse(result.stdout).annotationResolved : true;
  }, { timeout: 10_000 }).toBe(false);
  await page.evaluate(() => {
    const state = window as typeof window & { __GOAL07_TARGET?: Element; __GOAL07_NEXT?: ChildNode | null };
    document.querySelector("main")!.insertBefore(state.__GOAL07_TARGET!, state.__GOAL07_NEXT ?? null);
    delete state.__GOAL07_TARGET;
    delete state.__GOAL07_NEXT;
  });
  await expect.poll(() => {
    const result = cliFailure("status", "--runtime", selectedRuntimeId, "--annotation", id, "--check", "--json");
    return result.status === 0 && JSON.parse(result.stdout).annotationResolved;
  }, { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => window.__demoExtension?.studio?.commands.markers.show());

  // Diagnostics before a Handoff baseline are informational. A new 500 after
  // that baseline blocks only when the generated command opts in.
  const oldStatusLine = handoff.split("\n").find((line) =>
    line.startsWith("- status:") && line.includes(`--annotation ${id} `)
  )!;
  const oldStatusArgs = oldStatusLine.slice("- status: agent-annotations ".length).split(" ");
  expect(JSON.parse(cli(...oldStatusArgs))).toMatchObject({ diagnosticsAfterBaseline: 0, annotationResolved: true });
  await page.route("**/goal-07-500", (route) => route.fulfill({ status: 500, body: "failed" }));
  await page.evaluate(() => fetch("/goal-07-500"));
  await expect.poll(() => cliFailure(...oldStatusArgs).status).toBe(1);
  expect(JSON.parse(cliFailure(...oldStatusArgs).stdout).diagnosticsAfterBaseline).toBeGreaterThan(0);

  // Generate a fresh baseline, run its exact status command, then complete
  // from its summary-file placeholder with implementation+verification proof.
  await page.keyboard.press("Control+Alt+C");
  const completionHandoff = await page.evaluate(() => navigator.clipboard.readText());
  const statusLine = completionHandoff.split("\n").find((line) =>
    line.startsWith("- status:") && line.includes(`--annotation ${id} `)
  )!;
  const statusArgs = statusLine.slice("- status: agent-annotations ".length).split(" ");
  await expect.poll(() => JSON.parse(cli(...statusArgs)).annotationResolved, { timeout: 15_000 }).toBe(true);
  const completionLine = completionHandoff.split("\n").find((line) =>
    line.startsWith("- completion:") && line.includes(`complete ${id} `)
  )!;
  const completionArgs = completionLine.slice("- completion: agent-annotations ".length).split(" ");
  const summaryFile = path.resolve(completionArgs.at(-1)!);
  const completionSummary = "Implemented exact annotation health and verified unresolved recovery plus diagnostics baselines.";
  writeFileSync(summaryFile, completionSummary);
  await page.keyboard.press("Control+Alt+KeyJ");
  await expect.poll(() => page.evaluate(() => window.__demoExtension?.actionCount)).toBe(1);
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())))
    .toMatchObject({ format: "demo-json" });
  expect(cli("list")).toContain(id);
  expect(cli("print", "--markdown")).toContain("Make target purple");
  const beforeComplete = JSON.parse(cli("validate-task", "--json")).taskRevision;
  expect(cli(...completionArgs)).toContain(`taskRevision ${beforeComplete + 1}`);
  const completedTask = JSON.parse(readFileSync(taskPath, "utf8"));
  expect(completedTask.annotations.find((entry: { annotationId: string }) => entry.annotationId === id).completionEvidence.summary)
    .toBe(completionSummary);
  expect(completedTask.annotations.find((entry: { annotationId: string }) => entry.annotationId === id).completionEvidence.summary)
    .not.toBe("Make target purple");
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
    // Vite may coalesce or split one source edit into more than one legitimate
    // invalidation; the runtime must stay balanced and singleton, so only the
    // relative setup/dispose deltas and the single toolbar button are asserted.
    const baseline = await page.evaluate(() => ({
      setup: window.__demoExtension?.setupCount ?? 0,
      dispose: window.__demoExtension?.disposeCount ?? 0,
      buttons: document.getElementById("agent-annotations-root")?.shadowRoot
        ?.querySelectorAll('[data-action-id="demo.extension:demo-copy-json"]').length,
    }));
    writeFileSync(source, `${before}\n`);
    await expect.poll(() => page.evaluate(({ setup: baseSetup, dispose: baseDispose }) => {
      const setup = window.__demoExtension?.setupCount ?? 0;
      const dispose = window.__demoExtension?.disposeCount ?? 0;
      const buttons = document.getElementById("agent-annotations-root")?.shadowRoot
        ?.querySelectorAll('[data-action-id="demo.extension:demo-copy-json"]').length;
      return setup >= baseSetup + 1
        && setup - baseSetup === dispose - baseDispose
        && buttons === 1;
    }, { setup: baseline.setup, dispose: baseline.dispose })).toBe(true);
    const beforeAction = await page.evaluate(() => window.__demoExtension?.actionCount);
    await page.keyboard.press("Control+Alt+KeyJ");
    await expect.poll(() => page.evaluate(() => window.__demoExtension?.actionCount))
      .toBe((beforeAction ?? 0) + 1);
  } finally {
    writeFileSync(source, before);
  }
  await expect(page.locator("#agent-annotations-root")).toHaveCount(1);
});
