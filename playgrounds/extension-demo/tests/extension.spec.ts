import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const evidenceRoot = process.env.AGENT_ANNOTATIONS_EVIDENCE;
const extensionSource = path.resolve("src/demo-extension.ts");
const shadow = (page: Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);

test("external extension shares the public registry and survives HMR", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(shadow(page, ".aa-dock")).toBeVisible();

  const actionIds = await shadow(page, ".aa-action").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("data-action-id"))
  );
  expect(actionIds).toEqual([
    "agent-annotations.builtin:pick",
    "agent-annotations.builtin:multi",
    "agent-annotations.builtin:area",
    "agent-annotations.builtin:copy",
    "agent-annotations.builtin:clear",
    "demo.extension:demo-copy-json",
    "agent-annotations.builtin:visibility",
    "agent-annotations.builtin:help",
    "demo.extension:demo-panel-action",
    "agent-annotations.builtin:list",
    "agent-annotations.builtin:toggle",
  ]);
  if (evidenceRoot) {
    await page.screenshot({ path: path.join(evidenceRoot, "toolbar-and-demo-action.png") });
  }
  await expect(shadow(page, '[data-action-id="demo.extension:demo-copy-json"]'))
    .toHaveAttribute("aria-label", "Copy JSON (Ctrl+Alt+J)");
  await shadow(page, '[data-action-id="demo.extension:demo-copy-json"]').hover();
  await expect(shadow(page, '[role="tooltip"]')).toHaveText("Copy JSON (Ctrl+Alt+J)");

  await shadow(page, '[data-action-id="agent-annotations.builtin:help"]').click();
  await expect(shadow(page, '[aria-label="Shortcut help"]'))
    .toContainText("Copy JSONCtrl+Alt+J");
  if (evidenceRoot) {
    await page.screenshot({ path: path.join(evidenceRoot, "shortcut-help.png") });
  }
  await shadow(page, '[aria-label="Shortcut help"] button[aria-label="Close"]').click();

  await shadow(page, '[data-action-id="agent-annotations.builtin:list"]').click();
  await expect(shadow(page, '[aria-label="Annotation list"]')).toBeVisible();
  await shadow(page, '[data-action-id="demo.extension:demo-panel-action"]').click();
  await expect(shadow(page, ".aa-panel")).toHaveCount(1);
  await expect(shadow(page, '[aria-label="Demo Extension"]')).toContainText("demo-json");
  await expect.poll(() => page.evaluate(() =>
    document.getElementById("agent-annotations-root")?.shadowRoot?.activeElement
      ?.getAttribute("data-demo-panel-close")
  )).toBe("Close Demo");
  if (evidenceRoot) {
    await page.screenshot({ path: path.join(evidenceRoot, "demo-panel.png") });
  }
  await shadow(page, '[aria-label="Demo Extension"] button:has-text("Close Demo")').click();
  await expect(shadow(page, '[aria-label="Demo Extension"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    document.getElementById("agent-annotations-root")?.shadowRoot?.activeElement?.getAttribute("data-action-id")
  )).toBe("demo.extension:demo-panel-action");

  await shadow(page, '[data-action-id="agent-annotations.builtin:pick"]').click();
  await page.locator("#demo-target").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Keep Demo data safe");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => page.evaluate(() =>
    window.__demoExtension?.studio?.getSnapshot().task.annotations[0]?.extensions
  )).toEqual({
    "demo.extension": {
      "demo.extension:target-context": { demoKind: "primary", kept: "visible" },
    },
  });

  await shadow(page, '[data-action-id="agent-annotations.builtin:copy"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("# Agent Annotations Handoff");
  await page.locator("main").click();
  await page.keyboard.press("Control+Alt+KeyJ");
  await expect.poll(() => page.evaluate(() => window.__demoExtension?.actionCount)).toBe(1);
  const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(json).toMatchObject({
    format: "demo-json",
    annotations: [{ extensions: { "demo.extension": { "demo.extension:target-context": {
      demoKind: "primary",
      kept: "visible",
    } } } }],
  });
  expect(JSON.stringify(json)).not.toContain("redactMe");

  if (evidenceRoot) {
    writeFileSync(
      path.join(evidenceRoot, "task-extension.json"),
      JSON.stringify(
        await page.evaluate(() =>
          window.__demoExtension?.studio?.getSnapshot().task
        ),
        null,
        2
      )
    );
  }

  const before = readFileSync(extensionSource, "utf8");
  try {
    writeFileSync(extensionSource, `${before}\n`);
    await expect.poll(() => page.evaluate(() => ({
      setup: window.__demoExtension?.setupCount,
      dispose: window.__demoExtension?.disposeCount,
      buttons: document.getElementById("agent-annotations-root")?.shadowRoot
        ?.querySelectorAll('[data-action-id="demo.extension:demo-copy-json"]').length,
    }))).toEqual({ setup: 2, dispose: 1, buttons: 1 });
    const beforeAction = await page.evaluate(() => window.__demoExtension?.actionCount);
    await page.locator("main").click();
    await page.keyboard.press("Control+Alt+KeyJ");
    await expect.poll(() => page.evaluate(() => window.__demoExtension?.actionCount))
      .toBe((beforeAction ?? 0) + 1);
    if (evidenceRoot) {
      writeFileSync(
        path.join(evidenceRoot, "hmr-counters.json"),
        JSON.stringify(
          await page.evaluate(() => ({
            setupCount: window.__demoExtension?.setupCount,
            disposeCount: window.__demoExtension?.disposeCount,
            actionCount: window.__demoExtension?.actionCount,
          })),
          null,
          2
        )
      );
    }
  } finally {
    writeFileSync(extensionSource, before);
  }

});
