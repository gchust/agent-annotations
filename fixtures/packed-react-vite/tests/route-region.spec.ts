import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const shadow = (page: Page, selector: string) => page.locator(`#agent-annotations-root >> ${selector}`);

test.beforeAll(() => {
  // Start from a clean task even if this dev server already holds prior state.
  rmSync(taskPath, { force: true });
});

const revision = async (page: Page, token: string) => page.evaluate(async (value) => {
  const session = await (await fetch("/__agent-annotations/revision", {
    headers: { "x-agent-annotations-token": value },
  })).json();
  return session;
}, token);

test("route-aware markers, region targets, history navigation, and cross-route focus", async ({ page }) => {
  await page.goto("/route-a");
  await expect(page.locator("#region-fixture")).toBeVisible();

  // 1. Element annotation on /route-a with a selector that also exists on /route-b.
  await page.keyboard.press("Control+Alt+P");
  await page.locator("#shared-target").click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Route A shared target");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(1);

  // 2. Region annotation over duplicate wrappers with multiple source components.
  const fixture = page.locator("#region-fixture");
  await fixture.scrollIntoViewIfNeeded();
  const box = await fixture.boundingBox();
  expect(box).not.toBeNull();
  await page.keyboard.press("Control+Alt+A");
  await page.mouse.move(box!.x - 2, box!.y - 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width + 2, box!.y + box!.height + 2);
  await page.mouse.up();
  await expect(shadow(page, '[aria-label="Annotation composer"]')).toBeVisible();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Region with targets");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(2);

  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const region = task.annotations.find((entry: any) => entry.kind === "region");
  expect(region).toBeDefined();
  expect(region.region).toMatchObject({ coordinateSpace: "document" });
  expect(region.targets.length).toBeGreaterThanOrEqual(1);
  expect(region.targets.length).toBeLessThanOrEqual(50);
  const sources = new Set(region.targets.map((target: any) => target.inspection.source?.filePath));
  const componentSources = [...sources].filter((file) => file?.startsWith("src/route-a/"));
  expect(componentSources.length).toBeGreaterThanOrEqual(2);
  expect(region.extensions["demo.extension"]?.["demo.extension:target-context"]).toBeDefined();
  expect(JSON.stringify(region.extensions)).not.toContain("redactMe");
  console.log(`region-targets count=${region.targets.length} sources=${JSON.stringify([...sources])}`);

  // 3. Source revision changes for a file referenced only by a Region target.
  const regionOnly = path.resolve("src/route-a/RegionOnly.tsx");
  const token = JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8")).token;
  const baseline = await revision(page, token);
  expect(baseline.referencedSourceFiles).toContain("src/route-a/RegionOnly.tsx");
  const before = readFileSync(regionOnly, "utf8");
  try {
    writeFileSync(regionOnly, `${before}\n`);
    const after = await revision(page, token);
    expect(after.referencedSourceRevision).not.toBe(baseline.referencedSourceRevision);
  } finally {
    writeFileSync(regionOnly, before);
  }

  // 4. History navigation to /route-b: the identical selector must not bind the marker.
  await page.evaluate(() => {
    history.pushState({}, "", "/route-b");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("h1")).toHaveText("Route B");
  await expect(page.locator("#shared-target")).toBeVisible();
  await expect(shadow(page, ".aa-marker")).toHaveCount(0);

  // 5. The annotation list shows all routes; cross-route focus navigates back.
  await shadow(page, '[aria-label^="Annotations"]').click();
  await expect(shadow(page, ".aa-list-item")).toHaveCount(2);
  await shadow(page, 'button[aria-label^="Edit annotation"]').first().click();
  await expect(page.locator("h1")).toHaveText("Route A");
  await expect(shadow(page, ".aa-marker")).toHaveCount(2);
  // Route updates must not remount the Library.
  expect(await page.evaluate(() => window.__demoExtension?.setupCount)).toBe(1);
});
