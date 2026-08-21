import { expect, test, type Page } from "@playwright/test";

const artifactDir = process.env.AGENT_ANNOTATIONS_ARTIFACT_DIR ?? "/tmp/agent-annotations-g03";
const shadow = (page: Page, selector: string) => page.locator(`#agent-annotations-root >> ${selector}`);

const capturePick = async (page: Page, target: string, comment: string) => {
  await page.keyboard.press("Control+Alt+P");
  await page.locator(target).click({ position: { x: 12, y: 12 } });
  await expect(shadow(page, '[aria-label="Annotation composer"]')).toBeVisible();
  await shadow(page, '[aria-label="Annotation comment"]').fill(comment);
  await shadow(page, 'button[aria-label="Save annotation"]').click();
};

test("complete generic Pick/Multi/Area annotation closed loop", async ({ page, context }) => {
  await page.goto("/");
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect(shadow(page, ".aa-dock")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  expect(await shadow(page, ".aa-action").evaluateAll((buttons) =>
    buttons.every((button) => !!button.querySelector("svg") && !button.textContent?.trim())
  )).toBe(true);

  // The dock starts collapsed by default: expand and collapse through the
  // Ctrl+Alt+K hotkey (the visible Collapse button only exists when expanded).
  await page.keyboard.press("Control+Alt+K");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
  await page.screenshot({ path: `${artifactDir}/toolbar-expanded.png` });
  await page.keyboard.press("Control+Alt+K");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "true");
  await page.screenshot({ path: `${artifactDir}/toolbar-collapsed.png` });
  await page.keyboard.press("Control+Alt+K");
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");

  await page.keyboard.press("Control+Alt+P");
  await page.locator("#plain-button").click({ position: { x: 12, y: 12 } });
  await expect(shadow(page, '[aria-label="Annotation composer"]')).toBeVisible();
  const [targetBox, composerBox] = await Promise.all([
    page.locator("#plain-button").boundingBox(),
    shadow(page, '[aria-label="Annotation composer"]').boundingBox(),
  ]);
  expect(composerBox!.y - (targetBox!.y + targetBox!.height)).toBeCloseTo(8, 0);
  expect(await shadow(page, ".aa-composer button").evaluateAll((buttons) =>
    buttons.every((button) => !!button.querySelector("svg") && !button.textContent?.trim())
  )).toBe(true);
  await page.screenshot({ path: `${artifactDir}/pick-composer.png` });
  await shadow(page, '[aria-label="Annotation comment"]').fill("Make the plain button violet");
  const save = shadow(page, 'button[aria-label="Save annotation"]');
  await save.hover();
  await expect(shadow(page, '[role="tooltip"]')).toHaveText("Save annotation");
  await save.click();
  await expect.poll(() => page.evaluate(() => ({
    annotations: window.__agentAnnotations?.api.getSnapshot().task.annotations.length,
    composer: !!document.getElementById("agent-annotations-root")?.shadowRoot?.querySelector(".aa-composer"),
    status: document.getElementById("agent-annotations-root")?.shadowRoot?.querySelector('[role="status"]')?.textContent,
  }))).toEqual({ annotations: 1, composer: false, status: "Annotation saved" });
  await expect(shadow(page, '[aria-label="Annotation 1: edit"]')).toBeVisible();

  await shadow(page, 'button[aria-label^="Multi"]').click();
  await page.locator("#svg-button").click({ position: { x: 12, y: 12 } });
  await page.locator("#map-button").click({ position: { x: 12, y: 12 } });
  await page.keyboard.press("Enter");
  await shadow(page, '[aria-label="Annotation comment"]').fill("Align SVG and mapped item");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => page.evaluate(() => window.__agentAnnotations?.api.getSnapshot().task.annotations[1]?.targets?.length)).toBe(2);
  await page.screenshot({ path: `${artifactDir}/multi-annotation.png` });

  await page.keyboard.press("Control+Alt+A");
  const grid = await page.locator("#fixture-grid").boundingBox();
  expect(grid).not.toBeNull();
  const start = {
    x: Math.min(page.viewportSize()!.width - 4, grid!.x + grid!.width - 20),
    y: Math.min(page.viewportSize()!.height - 4, grid!.y + grid!.height - 20),
  };
  const end = {
    x: Math.max(4, Math.min(start.x - 60, grid!.x + 20)),
    y: Math.max(4, Math.min(start.y - 60, grid!.y + 20)),
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect(shadow(page, '[aria-label="Annotation composer"]')).toBeVisible();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Tighten the fixture grid");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => page.evaluate(() => window.__agentAnnotations?.api.getSnapshot().task.annotations[2]?.kind)).toBe("region");
  await page.screenshot({ path: `${artifactDir}/area-annotation.png` });

  await shadow(page, '[aria-label="Annotation 1: edit"]').click();
  await expect(shadow(page, '[aria-label="Annotation editor"]')).toBeVisible();
  await shadow(page, '[aria-label="Annotation editor"] textarea').fill("Make the plain button purple");
  await shadow(page, '[aria-label="Annotation editor"] button[aria-label="Save comment"]').click();
  await expect(shadow(page, '[aria-label="Annotation editor"]')).toHaveCount(0);
  await shadow(page, '[aria-label="Annotation 1: edit"]').click();
  await shadow(page, '[aria-label="Annotation editor"] button[aria-label="Complete"]').click();
  await expect.poll(() => page.evaluate(() =>
    window.__agentAnnotations?.api.getSnapshot().task.annotations[0]?.status
  )).toBe("completed");
  await expect(shadow(page, '[aria-label="Annotation 1: edit"]')).toHaveCount(0);
  await page.screenshot({ path: `${artifactDir}/marker-editor.png` });
  await shadow(page, '[aria-label="Annotation editor"] button[aria-label="Close"]').click();

  await shadow(page, 'button[aria-label^="Annotations"]').click();
  await expect(shadow(page, '[aria-label="Annotation list"]')).not.toContainText("Make the plain button purple");
  await page.screenshot({ path: `${artifactDir}/annotation-list-open.png` });
  await shadow(page, '[aria-label="Annotation list"] button:has-text("All")').click();
  await expect(shadow(page, '[aria-label="Annotation list"]')).toContainText("Make the plain button purple");
  await page.screenshot({ path: `${artifactDir}/annotation-list-all.png` });
  await shadow(page, '[aria-label="Annotation list"] button[aria-label="Edit annotation 1"]').click();
  await expect(shadow(page, '[aria-label="Annotation editor"]')).toBeVisible();

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await shadow(page, 'button[aria-label^="Copy"]').click();
  await expect(shadow(page, '[role="status"]')).toContainText("Copied open annotations");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).not.toContain("Make the plain button purple");
  expect(clipboard).toContain("Align SVG and mapped item");
  await page.screenshot({ path: `${artifactDir}/copy-success.png` });
  await shadow(page, '[aria-label="Annotation editor"] button[aria-label="Reopen"]').click();

  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await shadow(page, 'button[aria-label^="Copy"]').click();
  await expect(shadow(page, '[aria-label="Manual copy fallback"]')).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/copy-fallback.png` });
  await shadow(page, '[aria-label="Manual copy fallback"] button[aria-label="Close"]').click();

  await shadow(page, '[aria-label="Annotation editor"] button[aria-label="Close"]').click();
  await shadow(page, '[aria-label="Annotation 1: edit"]').click();
  await shadow(page, '[aria-label="Annotation editor"] button[aria-label="Delete"]').click();
  await expect.poll(() => page.evaluate(() => window.__agentAnnotations?.api.getSnapshot().task.annotations.length)).toBe(2);

  await page.evaluate(() => window.__unmountAgentAnnotations?.());
  await expect(page.locator("#agent-annotations-root")).toHaveCount(0);
  await page.screenshot({ path: `${artifactDir}/unmounted.png` });
  await page.evaluate(() => window.__remountAgentAnnotations?.());
  await expect(shadow(page, ".aa-dock")).toBeVisible();
});

test("host ignore, hotkeys, drag, tooltip, Help, and fixture targets", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#agent-annotations-root")).toHaveAttribute("data-react-grab-ignore", "");
  await page.keyboard.press("Control+Alt+KeyP");
  await expect.poll(() => page.evaluate(() => window.__agentAnnotations?.api.getSnapshot().captureMode)).toBe("pick");
  await shadow(page, 'button[aria-label^="Annotations"]').click();
  await expect(shadow(page, '[aria-label="Annotation list"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__agentAnnotations?.api.getSnapshot().captureMode)).toBe("pick");
  await shadow(page, 'button[aria-label^="Annotations"]').click();
  await page.keyboard.press("Escape");
  const pick = shadow(page, 'button[aria-label^="Pick"]');
  await pick.hover();
  await expect(shadow(page, '[role="tooltip"]')).toContainText("Pick");
  await shadow(page, 'button[aria-label^="Shortcut help"]').click();
  await expect(shadow(page, '[aria-label="Shortcut help"]')).toContainText("Ctrl+Alt+P");

  const grip = shadow(page, '[aria-label="Drag toolbar"]');
  const before = await shadow(page, ".aa-dock").boundingBox();
  await grip.dragTo(page.locator("header h1"));
  const after = await shadow(page, ".aa-dock").boundingBox();
  expect(after?.x).not.toBe(before?.x);
  await shadow(page, 'button[aria-label^="Shortcut help"]').click();
  const afterRender = await shadow(page, ".aa-dock").boundingBox();
  expect(afterRender?.x).toBeCloseTo(after!.x, 0);
  expect(afterRender?.y).toBeCloseTo(after!.y, 0);

  await expect(page.locator("#memo-card")).toBeVisible();
  await expect(page.locator("#forward-button")).toBeVisible();
  await page.locator("#popover-trigger").click();
  await expect(page.locator("#portal-popover")).toBeVisible();
  await expect(page.locator("#shadow-fixture").locator("#shadow-button")).toBeVisible();
  await page.locator("#bottom-button").scrollIntoViewIfNeeded();
  await expect(page.locator("#bottom-button")).toBeInViewport();
});

test("captures SVG, map, memo, forwardRef, Portal, and Shadow Root targets", async ({ page }) => {
  await page.goto("/");
  await page.locator("#popover-trigger").click();
  const targets = [
    ["#svg-button", "SVG"],
    ["#map-button", "map"],
    ["#memo-card", "memo"],
    ["#forward-button", "forwardRef"],
    ["#portal-action", "Portal"],
  ] as const;
  for (const [selector, label] of targets) {
    await capturePick(page, selector, `Capture ${label}`);
  }
  await page.keyboard.press("Control+Alt+P");
  await page.locator("#shadow-fixture").locator("#shadow-button").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Capture Shadow Root");
  await shadow(page, 'button[aria-label="Save annotation"]').click();

  const task = await page.evaluate(() => window.__agentAnnotations?.api.getSnapshot().task);
  expect(task?.annotations).toHaveLength(6);
  expect(task?.annotations.every((annotation) => annotation.targets?.[0]?.selector)).toBe(true);
  expect(task?.annotations.some((annotation) => annotation.targets?.[0]?.selector.includes(">>>"))).toBe(true);
});
