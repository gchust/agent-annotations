import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const evidenceRoot = process.env.AGENT_ANNOTATIONS_EVIDENCE
  ?? path.join(tmpdir(), "agent-annotations-packed-react-vite-evidence");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);
const annotations = () => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length;
const activeElement = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const documentNode = document.activeElement as HTMLElement | null;
    const host = document.getElementById("agent-annotations-root");
    const shadowNode = host?.shadowRoot?.activeElement as HTMLElement | null;
    const node = shadowNode ?? documentNode;
    return node?.getAttribute("aria-label") ?? node?.id ?? "";
  });
const tabUntil = async (page: import("@playwright/test").Page, labelPrefix: string) => {
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press("Tab");
    if ((await activeElement(page)).startsWith(labelPrefix)) return;
  }
  throw new Error(`Tab never reached ${labelPrefix}; active=${await activeElement(page)}`);
};
const shot = (name: string) => path.join(evidenceRoot, `ux-${name}.png`);

test("keyboard-only Pick, Multi, Copy, List, and Collapse flows with visual evidence", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await page.keyboard.press("Control+Alt+C");
  const emptyHandoff = await page.evaluate(() => navigator.clipboard.readText());
  expect(emptyHandoff).toContain("agent-annotations validate-task --json");
  expect(emptyHandoff).not.toContain("agent-annotations wait ");
  expect(emptyHandoff).not.toContain("agent-annotations status ");
  // The dock starts expanded by default; collapse it to exercise the compact chrome.
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
  await page.keyboard.press("Control+Alt+K");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "true");
  await expect(shadow(page, ".aa-collapsed-count")).toBeVisible();
  await page.screenshot({ path: shot("collapsed") });

  // A capture hotkey while collapsed auto-expands the dock and starts pick.
  await page.keyboard.press("Control+Alt+P");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "true");
  await expect(shadow(page, '[aria-label="Annotations (Ctrl+Alt+L)"]')).toBeVisible();
  await expect(shadow(page, '[aria-label="Shortcut help (Shift+/)"]')).toBeVisible();

  // Expanded dock evidence.
  await page.screenshot({ path: shot("expanded") });

  // Tooltip evidence: hover shows the registered shortcut on the visible
  // toolbar button.
  await shadow(page, '[aria-label^="Pick"]').hover();
  await expect(shadow(page, '[role="tooltip"]')).toContainText("Pick (Ctrl+Alt+P)");
  await page.screenshot({ path: shot("tooltip") });
  // Keyboard focus reaches the same tooltip, and Escape dismisses it.
  await tabUntil(page, "Pick");
  expect(await activeElement(page)).toBe("Pick (Ctrl+Alt+P)");
  await expect(shadow(page, '[role="tooltip"]')).toContainText("Pick (Ctrl+Alt+P)");
  await page.keyboard.press("Escape");
  await expect(shadow(page, '[role="tooltip"]')).toHaveCount(0);
  // Escape also cancels the armed capture by contract, so re-arm before the
  // keyboard-only Pick flow.
  await page.keyboard.press("Control+Alt+P");
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "true");

  // Keyboard-only Pick: Tab to the target, Enter, comment, save.
  await tabUntil(page, "target");
  await page.keyboard.press("Enter");
  await expect(shadow(page, '[aria-label="Annotation comment"]')).toBeFocused();
  await page.keyboard.type("Keyboard pick");
  await page.screenshot({ path: shot("capture") });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => annotations()).toBe(1);
  await expect(shadow(page, ".aa-composer")).toHaveCount(0);
  // Saving exits capture mode.
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "false");

  // Keyboard-only Multi: hotkey, two keyboard targets, Tab to the visible Finish action.
  await page.keyboard.press("Control+Alt+M");
  await expect(shadow(page, '[aria-label^="Multi"]')).toHaveAttribute("aria-pressed", "true");
  await tabUntil(page, "duplicate-a");
  await page.keyboard.press("Enter");
  await tabUntil(page, "duplicate-b");
  await page.keyboard.press("Enter");
  const finish = shadow(page, '[aria-label^="Complete selection"]');
  await expect(finish).toBeVisible();
  await tabUntil(page, "Complete selection");
  expect(await activeElement(page)).toContain("Complete selection (2)");
  await page.keyboard.press("Enter");
  await expect(shadow(page, '[aria-label="Annotation comment"]')).toBeFocused();
  await page.keyboard.type("Keyboard multi");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => annotations()).toBe(2);
  await expect(finish).toHaveCount(0);
  await expect(shadow(page, '[aria-label^="Multi"]')).toHaveAttribute("aria-pressed", "false");

  // Keyboard-only Copy: the open annotations land on the clipboard untouched.
  await page.keyboard.press("Control+Alt+C");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("Keyboard pick");
  expect(clipboard).toContain("Keyboard multi");
  expect(clipboard).toContain("# Agent Annotations Handoff");
  expect(clipboard).toContain("Run the project-relevant typecheck and tests");
  expect(clipboard).toContain("agent-annotations validate-task --json");
  expect(clipboard).toContain("agent-annotations complete ");
  expect(clipboard).toContain("--verified --summary-file");
  expect(clipboard).not.toContain("agent-annotations wait ");
  expect(clipboard).not.toContain("agent-annotations status ");
  expect(clipboard).not.toContain("diagnostics baseline");
  await expect.poll(() => annotations()).toBe(2);
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "false");
  await expect(shadow(page, '[aria-label^="Multi"]')).toHaveAttribute("aria-pressed", "false");
  await expect(shadow(page, '[aria-label^="Markers"]')).toHaveAttribute("aria-pressed", "true");

  // Clear All uses the built-in confirmation panel; cancel preserves the task.
  await shadow(page, '[aria-label="Clear all annotations"]').click();
  await expect(shadow(page, '.aa-panel[aria-label="Clear all annotations"]')).toBeVisible();
  await expect(shadow(page, ".aa-confirm")).toContainText("Clear all 2 annotations?");
  await shadow(page, '.aa-confirm [aria-label="Cancel"]').click();
  await expect(shadow(page, '.aa-panel[aria-label="Clear all annotations"]')).toHaveCount(0);
  await expect.poll(() => annotations()).toBe(2);

  // Keyboard-only List with the confirmed Remove completed control.
  await page.keyboard.press("Control+Alt+L");
  await expect(shadow(page, '[aria-label="Annotation list"]')).toBeVisible();
  const remove = shadow(page, '[aria-label^="Remove completed"]');
  await expect(remove).toHaveAttribute("aria-label", "Remove completed (0)");
  await expect(remove).toBeDisabled();
  await page.screenshot({ path: shot("list") });
  await page.keyboard.press("Escape");

  // Keyboard-only Collapse: collapsed chrome shows the open count; K restores.
  await page.keyboard.press("Control+Alt+K");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "true");
  await expect(shadow(page, ".aa-collapsed-count")).toHaveText("2");
  await expect(shadow(page, ".aa-collapsed-count")).toHaveAttribute("aria-expanded", "false");
  // The collapsed count is itself a tooltip-capable control. Move the mouse away
  // first: the count sits at the same coordinates the cursor already hovers.
  await page.mouse.move(10, 10);
  await shadow(page, ".aa-collapsed-count").hover();
  await expect(shadow(page, '[role="tooltip"]')).toContainText("2 open annotations");
  await page.screenshot({ path: shot("collapsed") });
  await page.keyboard.press("Control+Alt+K");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
  await expect(shadow(page, ".aa-collapsed-count")).toHaveCount(0);

  // Dock position survives a full reload and clamps after a resize.
  const grip = shadow(page, ".aa-grip");
  const box = await grip.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 17, box!.y + 17);
  await page.mouse.down();
  await page.mouse.move(box!.x + 117, box!.y + 17, { steps: 3 });
  await page.mouse.up();
  const dockBox = await shadow(page, ".aa-dock").boundingBox();
  expect(dockBox).not.toBeNull();
  const draggedLeft = dockBox!.x;
  await page.reload();
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  // A reload resets to the default expanded initial state.
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
  const restored = await shadow(page, ".aa-dock").boundingBox();
  expect(restored!.x).toBeCloseTo(draggedLeft, 0);
  // Resize into a viewport that still fits the dock but forces the saved
  // position to clamp on both axes: x and y end at the maximum legal offset.
  await page.setViewportSize({ width: 600, height: 300 });
  await expect
    .poll(async () => {
      const box = await shadow(page, ".aa-dock").boundingBox();
      if (!box) return -1;
      const clampedX = box.x >= 0 && box.x + box.width <= 600;
      const clampedY = box.y >= 0 && box.y + box.height <= 300;
      const maxX = Math.abs(box.x - (600 - box.width)) < 1;
      const maxY = Math.abs(box.y - (300 - box.height)) < 1;
      return clampedX && clampedY && maxX && maxY ? 1 : -1;
    })
    .toBe(1);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Tooltip flips below a dock pinned to the top edge and stays fully onscreen.
  const topBox = await grip.boundingBox();
  expect(topBox).not.toBeNull();
  await page.mouse.move(topBox!.x + 17, topBox!.y + 17);
  await page.mouse.down();
  await page.mouse.move(topBox!.x + 17, 2, { steps: 3 });
  await page.mouse.up();
  const viewport = page.viewportSize()!;
  await page.mouse.move(10, 10);
  await shadow(page, '[aria-label^="Multi"]').hover();
  let tooltipBox = await shadow(page, '[role="tooltip"]').boundingBox();
  let multiBox = await shadow(page, '[aria-label^="Multi"]').boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(multiBox).not.toBeNull();
  expect(tooltipBox!.y).toBeGreaterThanOrEqual(multiBox!.y + multiBox!.height);
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.y).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  // Tooltip clamps inside the right edge: right-align the dock first, prove the
  // alignment, then hover the rightmost longest-label control (Collapse).
  const rightBox = await grip.boundingBox();
  expect(rightBox).not.toBeNull();
  await page.mouse.move(rightBox!.x + 17, rightBox!.y + 17);
  await page.mouse.down();
  await page.mouse.move(viewport.width - 10, rightBox!.y + 17, { steps: 3 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const dock = await shadow(page, ".aa-dock").boundingBox();
      return dock ? Math.abs(dock.x + dock.width - viewport.width) : -1;
    })
    .toBeLessThan(2);
  await page.mouse.move(10, 10);
  await shadow(page, '[aria-label^="Collapse toolbar"]').hover();
  tooltipBox = await shadow(page, '[role="tooltip"]').boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.y).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
});

test("dark system theme and cleanup preserve open annotations and their evidence", async ({ page }) => {
  // The shared task store already contains the two open annotations from the
  // previous test; capture their evidence references before any cleanup.
  const before = JSON.parse(readFileSync(taskPath, "utf8")).annotations;
  const openBefore = before.filter((entry: { status: string }) => entry.status === "open");
  expect(openBefore.length).toBeGreaterThan(0);
  const openEvidence = openBefore.map((entry: { annotationId: string; evidence: unknown[] }) => ({
    annotationId: entry.annotationId,
    evidence: entry.evidence ?? [],
  }));
  for (const entry of openEvidence) {
    // The preservation assertion only means something when the refs are real.
    expect(entry.evidence.length).toBeGreaterThan(0);
  }

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect(page.locator("#agent-annotations-root")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: shot("dark") });

  // Keyboard-only Pick for a disposable annotation.
  await page.keyboard.press("Control+Alt+P");
  await tabUntil(page, "target");
  await page.keyboard.press("Enter");
  await expect(shadow(page, '[aria-label="Annotation comment"]')).toBeFocused();
  await page.keyboard.type("To clean up");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => annotations()).toBe(openBefore.length + 1);
  await shadow(page, '[data-annotation-id]').last().click();
  await expect(shadow(page, '[aria-label="Annotation editor"]')).toBeVisible();
  await shadow(page, '[aria-label="Complete"]').click();
  await expect.poll(
    () => JSON.parse(readFileSync(taskPath, "utf8")).annotations
      .find((entry: { comment: string }) => entry.comment === "To clean up")?.status
  ).toBe("completed");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Alt+L");
  const remove = shadow(page, '[aria-label^="Remove completed"]');
  await expect(remove).toHaveAttribute("aria-label", "Remove completed (1)");
  await remove.click();
  await expect(shadow(page, ".aa-confirm")).toContainText("Remove 1 completed annotation?");
  await shadow(page, '.aa-confirm [aria-label="Remove"]').click();
  await expect.poll(() => annotations()).toBe(openBefore.length);
  await expect(remove).toHaveAttribute("aria-label", "Remove completed (0)");
  await expect(remove).toBeDisabled();
  await page.screenshot({ path: shot("cleanup") });

  // Every prior open annotation and its evidence references survived untouched.
  const after = JSON.parse(readFileSync(taskPath, "utf8")).annotations;
  for (const expected of openEvidence) {
    const entry = after.find((item: { annotationId: string }) => item.annotationId === expected.annotationId);
    expect(entry).toBeDefined();
    expect(entry.status).toBe("open");
    expect(entry.evidence ?? []).toEqual(expected.evidence);
  }
  expect(after.some((entry: { comment: string }) => entry.comment === "To clean up")).toBe(false);
});
