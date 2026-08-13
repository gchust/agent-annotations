import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-feedback");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-feedback-root >> ${selector}`);
const save = async (page: import("@playwright/test").Page, target: import("@playwright/test").Locator, comment: string) => {
  const expected = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length + 1;
  await shadow(page, '[aria-label^="Pick"]').click();
  await target.click();
  await shadow(page, '[aria-label="Annotation comment"]').fill(comment);
  await shadow(page, 'button:has-text("Save annotation")').click();
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(expected);
};

test("screenshot keeps style, media geometry, scroll, large viewport and aligned overlay", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  const card = page.locator("#screenshot-card");
  await card.scrollIntoViewIfNeeded();
  const before = await card.boundingBox();
  expect(before).not.toBeNull();
  const screenshotStarted = Date.now();
  await save(page, card, "Screenshot evidence");
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.at(-1).evidence?.length ?? 0, { timeout: 10_000 }).toBe(1);
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const annotation = task.annotations.at(-1);
  expect(annotation.targets[0].bounds).toMatchObject({
    x: expect.closeTo(before!.x, 0),
    y: expect.closeTo(before!.y, 0),
    width: expect.closeTo(before!.width, 0),
    height: expect.closeTo(before!.height, 0),
  });
  const evidence = annotation.evidence.at(-1);
  expect(evidence).toMatchObject({ kind: "screenshot", mediaType: "image/png", width: 1600, height: 900 });
  const png = readFileSync(path.join(runtimeRoot, evidence.ref));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.length).toBeGreaterThan(500);
  console.log(`screenshot durationMs=${Date.now() - screenshotStarted} pngBytes=${png.length}`);
  const after = await card.boundingBox();
  expect(after).toEqual(before);
});

test("nested iframe and iframe open-shadow markers save and recover after reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#same-origin-frame")).toHaveAttribute("data-ready", "true");
  const initial = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length;
  const outer = page.frameLocator("#same-origin-frame");
  await save(page, outer.frameLocator("#nested-frame").locator("#nested-target"), "Nested frame");
  await save(page, outer.locator("#frame-shadow").locator("#frame-shadow-target"), "Frame shadow");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  expect(task.annotations.map((entry: any) => entry.targets?.[0]?.selector)).toEqual(expect.arrayContaining([
    expect.stringContaining(">>iframe>>"),
    expect.stringContaining(">>>"),
  ]));
  await page.reload();
  await expect(page.locator("#same-origin-frame")).toHaveAttribute("data-ready", "true");
  const recovered = [
    outer.frameLocator("#nested-frame").locator("#nested-target"),
    outer.locator("#frame-shadow").locator("#frame-shadow-target"),
  ];
  for (const [index, annotation] of task.annotations.slice(initial).entries()) {
    const marker = shadow(page, `[data-annotation-id="${annotation.annotationId}"]`);
    await expect(marker).toBeVisible();
    const [markerBox, targetBox] = await Promise.all([marker.boundingBox(), recovered[index]!.boundingBox()]);
    expect(markerBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(markerBox!.x).toBeCloseTo(targetBox!.x - 8, 0);
    expect(markerBox!.y).toBeCloseTo(targetBox!.y - 8, 0);
  }
});

test("cross-origin stays explicitly unsupported and public freeze keeps toolbar and page usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#cross-origin-frame")).toBeAttached();
  expect(await page.locator("#cross-origin-frame").evaluate((frame: HTMLIFrameElement) => {
    try {
      void frame.contentWindow?.document;
      return "resolved";
    } catch {
      return "unsupported";
    }
  })).toBe("unsupported");
  const original = await page.evaluate(() => String(window.requestAnimationFrame));
  await shadow(page, '[aria-label^="Pick"]').click();
  await page.locator("#animated-target").click();
  await expect(shadow(page, '[aria-label="Annotation composer"]')).toBeVisible();
  await expect(shadow(page, '[aria-label^="Annotations"]')).toBeEnabled();
  await shadow(page, '[aria-label="Cancel"]').click();
  expect(await page.evaluate((originalString) => String(window.requestAnimationFrame) === originalString, original)).toBe(true);
  const dynamicBefore = await page.locator("#dynamic-target").textContent();
  await page.locator("#popover-toggle").click();
  await expect(page.locator("#fixture-popover")).toBeVisible();
  await expect.poll(() => page.locator("#dynamic-target").textContent()).not.toBe(dynamicBefore);
  expect(await page.locator("#animated-target").evaluate((element) => getComputedStyle(element).animationName)).toBe("fixture-pulse");
  await page.locator("#portal-toggle").click();
  await expect(page.locator("#portal-target")).toBeVisible();
  await expect(page.locator("#dynamic-target")).toContainText("Dynamic");
});

test("region is bounded and semantic target survives wrapper-heavy sampling", async ({ page }) => {
  await page.goto("/");
  const box = await page.locator("#wrapper-fixture").boundingBox();
  expect(box).not.toBeNull();
  const durations: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const started = Date.now();
    await shadow(page, '[aria-label^="Area"]').click();
    await page.mouse.move(box!.x, box!.y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width, box!.y + box!.height);
    await page.mouse.up();
    await expect(shadow(page, '[aria-label="Annotation composer"]')).toContainText("Area (1 sampled targets)");
    durations.push(Date.now() - started);
    await page.keyboard.press("Escape");
  }
  console.log(`area-69 worstDurationMs=${Math.max(...durations)}`);
});

test("dynamic marker refresh stays rAF-bounded and observers stop with hidden markers", async ({ page }) => {
  await page.goto("/");
  await save(page, page.locator("#dynamic-target"), "Dynamic marker");
  const marker = shadow(page, ".af-marker").last();
  await expect(marker).toBeVisible();
  const before = await marker.boundingBox();
  await page.waitForTimeout(10_000);
  const after = await marker.boundingBox();
  expect(after).not.toBeNull();
  expect(before?.x).toBe(after?.x);
  const refreshes = Number(await page.locator("#agent-feedback-root").getAttribute("data-marker-refreshes"));
  console.log(`dynamic-dom markerRefreshes10s=${refreshes}`);
  expect(refreshes).toBeLessThan(60);
  await shadow(page, '[aria-label^="Markers"]').click();
  await expect(shadow(page, ".af-marker")).toHaveCount(0);
});
