import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);
const save = async (page: import("@playwright/test").Page, target: import("@playwright/test").Locator, comment: string) => {
  const expected = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length + 1;
  // Runtime readiness: the dock must be mounted before the shortcut is
  // dispatched, otherwise the keydown arrives before the listener exists.
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await page.keyboard.press("Control+Alt+P");
  // The capture hotkey must have armed Pick before the click reaches the
  // target; a click while unarmed would only focus the element.
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "true");
  await target.click();
  await expect(shadow(page, '[aria-label="Annotation comment"]')).toBeVisible();
  await shadow(page, '[aria-label="Annotation comment"]').fill(comment);
  await shadow(page, 'button[aria-label="Save annotation"]').click();
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
  expect(annotation.targets[0].bounds.x).toBeCloseTo(before!.x, 0);
  expect(annotation.targets[0].bounds.y).toBeCloseTo(before!.y, 0);
  expect(annotation.targets[0].bounds.width).toBeCloseTo(before!.width, 0);
  expect(annotation.targets[0].bounds.height).toBeCloseTo(before!.height, 0);
  const evidence = annotation.evidence.at(-1);
  expect(evidence).toMatchObject({ kind: "screenshot", mediaType: "image/png", width: 1600, height: 900 });
  const png = readFileSync(path.join(runtimeRoot, evidence.ref));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.length).toBeGreaterThan(500);
  console.log(`screenshot durationMs=${Date.now() - screenshotStarted} pngBytes=${png.length}`);
  const after = await card.boundingBox();
  expect(after).toEqual(before);
  // Pixel evidence: the page is scrolled, so the overlay must sit at the
  // card's viewport position in the PNG (no double scroll subtraction). The
  // card background rgb(12,34,56) blended with the indigo overlay tint is
  // ~rgb(24,43,81); the raw background would be exactly rgb(12,34,56).
  const samples = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const rect = document.getElementById("screenshot-card")!.getBoundingClientRect();
    const scale = image.width / innerWidth;
    const sample = (x: number, y: number) => {
      const data = context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [data[0], data[1], data[2]];
    };
    return {
      inside: sample(rect.x + 8, rect.y + 8),
      outside: sample(rect.x - 8, rect.y - 8),
    };
  }, png.toString("base64"));
  expect(samples.inside).not.toEqual([12, 34, 56]);
  expect(samples.inside[0]).toBeGreaterThan(16);
  expect(samples.inside[0]).toBeLessThan(34);
  expect(samples.inside[2]).toBeGreaterThan(60);
  expect(samples.inside[2]).toBeLessThan(102);
  console.log(`overlay-pixels inside=${JSON.stringify(samples.inside)} outside=${JSON.stringify(samples.outside)}`);
});

test("automatic evidence preserves frozen popover state without blocking saved UI", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.locator("#popover-toggle").click();
  const popover = page.locator("#fixture-popover");
  await expect(popover).toBeVisible();
  const popoverBox = await popover.boundingBox();
  expect(popoverBox).not.toBeNull();
  await page.evaluate(() => {
    const nativeDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (!this.src.startsWith("data:image/svg+xml")) return nativeDecode.call(this);
      (window as typeof window & { evidenceDecodeStarted?: number }).evidenceDecodeStarted = Date.now();
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => nativeDecode.call(this).then(() => {
          (window as typeof window & { evidenceDecodeFinished?: number }).evidenceDecodeFinished = Date.now();
          resolve();
        }, reject), 5_000);
      });
    };
    const root = document.querySelector("#agent-annotations-root")!.shadowRoot!;
    new MutationObserver(() => {
      if (root.querySelector('[role="status"]')?.textContent === "Annotation saved") {
        document.querySelector<HTMLElement>("#fixture-popover")!.hidePopover();
      }
    }).observe(root, { childList: true, subtree: true });
  });

  await page.keyboard.press("Control+Alt+P");
  await expect(shadow(page, '[aria-label^="Pick"]')).toHaveAttribute("aria-pressed", "true");
  await popover.click();
  await expect(shadow(page, '[aria-label="Annotation comment"]')).toBeVisible();
  const submittedAt = Date.now();
  await page.evaluate(() => {
    const root = document.querySelector("#agent-annotations-root")!.shadowRoot!;
    const textarea = root.querySelector<HTMLTextAreaElement>('[aria-label="Annotation comment"]')!;
    textarea.value = "Frozen popover evidence";
    textarea.closest("form")!.requestSubmit();
  });
  await expect(shadow(page, '[role="status"]')).toHaveText("Annotation saved", { timeout: 2_000 });
  expect(Date.now() - submittedAt).toBeLessThan(2_000);
  await expect(popover).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { evidenceDecodeStarted?: number }).evidenceDecodeStarted ?? 0
  )).toBeGreaterThan(0);
  const taskBeforeDecode = JSON.parse(readFileSync(taskPath, "utf8"));
  expect(taskBeforeDecode.annotations.at(-1).evidence?.length ?? 0).toBe(0);
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.at(-1).evidence?.length ?? 0, { timeout: 15_000 }).toBe(1);
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const evidence = task.annotations.at(-1).evidence.at(-1);
  const png = readFileSync(path.join(runtimeRoot, evidence.ref));
  const sample = await page.evaluate(async ({ base64, x, y }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const scale = image.width / innerWidth;
    return [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
  }, { base64: png.toString("base64"), x: popoverBox!.x + 12, y: popoverBox!.y + 12 });
  expect(sample[0]).toBeGreaterThan(150);
  expect(sample[1]).toBeGreaterThan(130);
  expect(sample[2]).toBeLessThan(160);
  const decodeDuration = await page.evaluate(() => {
    const state = window as typeof window & { evidenceDecodeStarted?: number; evidenceDecodeFinished?: number };
    return state.evidenceDecodeFinished! - state.evidenceDecodeStarted!;
  });
  expect(decodeDuration).toBeGreaterThanOrEqual(5_000);
  console.log(`frozen-popover decodeDurationMs=${decodeDuration} sample=${JSON.stringify(sample)}`);
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

test("multi target summary, highlights, and iframe tracking share dynamic refreshes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#same-origin-frame")).toHaveAttribute("data-ready", "true");
  const frame = page.frameLocator("#same-origin-frame");
  await page.locator("#same-origin-frame").evaluate((node: HTMLIFrameElement) => {
    const button = node.contentDocument!.createElement("button");
    button.id = "late-multi-target";
    button.textContent = "Late multi target";
    node.contentDocument!.body.prepend(button);
  });

  const initial = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length;
  await page.keyboard.press("Control+Alt+M");
  await expect(shadow(page, '[aria-label^="Multi"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#target").click();
  await frame.locator("#late-multi-target").click();
  await shadow(page, '[aria-label^="Complete selection"]').click();
  await shadow(page, '[aria-label="Annotation comment"]').fill("Dynamic iframe multi target");
  await shadow(page, 'button[aria-label="Save annotation"]').click();
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(initial + 1);
  const annotation = JSON.parse(readFileSync(taskPath, "utf8")).annotations.at(-1);
  expect(annotation.kind).toBe("multi");
  expect(annotation.targets).toHaveLength(2);

  const marker = shadow(page, `.aa-marker[data-annotation-id="${annotation.annotationId}"]`);
  await expect(marker).toHaveAttribute("data-resolved", "2");
  await frame.locator("#late-multi-target").evaluate((node) => node.remove());
  await expect(marker).toHaveAttribute("data-resolved", "1");
  await expect(marker).toHaveAttribute("data-total", "2");
  await shadow(page, '[aria-label^="Annotations"]').click();
  const listItem = shadow(page, `.aa-list-item[data-annotation-id="${annotation.annotationId}"]`);
  await expect(listItem).toContainText("1/2 targets");

  await page.locator("#same-origin-frame").evaluate((node: HTMLIFrameElement) => {
    const button = node.contentDocument!.createElement("button");
    button.id = "late-multi-target";
    button.textContent = "Late multi target";
    node.contentDocument!.body.prepend(button);
  });
  await expect(marker).toHaveAttribute("data-resolved", "2");
  await expect(listItem).toContainText("2/2 targets");
  await page.keyboard.press("Escape");

  await marker.focus();
  const highlights = shadow(page, ".aa-marker-highlight");
  await expect(highlights).toHaveCount(2);
  const assertAligned = async () => {
    await expect.poll(async () => {
      const targetBoxes = await Promise.all([
        page.locator("#target").boundingBox(),
        frame.locator("#late-multi-target").boundingBox(),
      ]);
      const highlightBoxes = await Promise.all([
        highlights.nth(0).boundingBox(),
        highlights.nth(1).boundingBox(),
      ]);
      return highlightBoxes.map((box, index) => ({
        x: Math.round(box!.x - targetBoxes[index]!.x),
        y: Math.round(box!.y - targetBoxes[index]!.y),
        width: Math.round(box!.width - targetBoxes[index]!.width),
        height: Math.round(box!.height - targetBoxes[index]!.height),
      }));
    }).toEqual([
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]);
  };
  await assertAligned();
  await page.evaluate(() => scrollBy(0, 30));
  await assertAligned();
  await page.setViewportSize({ width: 1200, height: 800 });
  await assertAligned();

  await shadow(page, '[aria-label^="Markers"]').click();
  await expect(shadow(page, ".aa-marker")).toHaveCount(0);
  const stopped = Number(await page.locator("#agent-annotations-root").getAttribute("data-marker-refreshes"));
  await page.waitForTimeout(500);
  expect(Number(await page.locator("#agent-annotations-root").getAttribute("data-marker-refreshes"))).toBe(stopped);
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
  await page.keyboard.press("Control+Alt+P");
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
  const semantic = page.locator("#semantic-region-target");
  await semantic.scrollIntoViewIfNeeded();
  const box = await semantic.boundingBox();
  expect(box).not.toBeNull();
  const durations: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const started = Date.now();
    await page.keyboard.press("Control+Alt+A");
    await page.mouse.move(box!.x - 2, box!.y - 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width + 2, box!.y + box!.height + 2);
    await page.mouse.up();
    await expect(shadow(page, '[aria-label="Annotation composer"]')).toContainText("Area (1 sampled targets)");
    durations.push(Date.now() - started);
    await page.keyboard.press("Escape");
  }
  console.log(`area-69 worstDurationMs=${Math.max(...durations)}`);
});

test("screenshot sanitizes form values while preserving layout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const fixture = page.locator("#privacy-fixture");
  await fixture.scrollIntoViewIfNeeded();
  const before = await fixture.boundingBox();
  expect(before).not.toBeNull();
  await save(page, page.locator("#privacy-capture-target"), "Privacy evidence");
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.at(-1)?.evidence?.length ?? 0, { timeout: 10_000 }).toBe(1);
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const annotation = task.annotations.at(-1);
  const evidence = annotation.evidence.at(-1);
  const png = readFileSync(path.join(runtimeRoot, evidence.ref));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  // The live DOM is untouched: sentinel values are still present.
  expect(await page.locator("#privacy-input").inputValue()).toBe("SENTINEL_INPUT");
  expect(await page.locator("#privacy-password").inputValue()).toBe("SENTINEL_PASSWORD");
  expect(await page.locator("#privacy-textarea").inputValue()).toBe("SENTINEL_AREA");
  expect(await page.locator("#privacy-editable").textContent()).toBe("SENTINEL_EDITABLE");
  // Layout is preserved after the capture.
  const after = await fixture.boundingBox();
  expect(after).toEqual(before);
  // The captured image visibly renders each control at its live position.
  const samples = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const scale = image.width / innerWidth;
    const sample = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const data = context.getImageData(
        Math.round((rect.x + rect.width / 2) * scale),
        Math.round((rect.y + rect.height / 2) * scale),
        1,
        1
      ).data;
      return [data[0], data[1], data[2]];
    };
    return {
      width: image.width,
      height: image.height,
      input: sample("#privacy-input"),
      password: sample("#privacy-password"),
      textarea: sample("#privacy-textarea"),
      editable: sample("#privacy-editable"),
    };
  }, png.toString("base64"));
  expect(samples.width).toBeGreaterThan(0);
  expect(samples.input).toEqual([220, 40, 40]);
  expect(samples.password).toEqual([40, 180, 40]);
  expect(samples.textarea).toEqual([40, 40, 220]);
  expect(samples.editable).toEqual([220, 180, 40]);
  console.log(`privacy-screenshot ${JSON.stringify(samples)}`);
});

test("removing an annotation deletes its orphan evidence", async ({ page }) => {
  await page.goto("/");
  const initial = JSON.parse(readFileSync(taskPath, "utf8")).annotations.length;
  await save(page, page.locator("#target"), "Evidence cleanup");
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.at(-1)?.evidence?.length ?? 0, { timeout: 10_000 }).toBe(1);
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const annotation = task.annotations.at(-1);
  const evidence = annotation.evidence.at(-1);
  const evidencePath = path.join(runtimeRoot, evidence.ref);
  expect(existsSync(evidencePath)).toBe(true);
  await shadow(page, `[data-annotation-id="${annotation.annotationId}"]`).click();
  await shadow(page, 'button[aria-label="Delete"]').click();
  await expect.poll(() => JSON.parse(readFileSync(taskPath, "utf8")).annotations.length).toBe(initial);
  expect(existsSync(evidencePath)).toBe(false);
});

test("dynamic marker refresh stays rAF-bounded and observers stop with hidden markers", async ({ page }) => {
  await page.goto("/");
  await save(page, page.locator("#dynamic-target"), "Dynamic marker");
  const marker = shadow(page, ".aa-marker").last();
  await expect(marker).toBeVisible();
  // Atomic measurement: read x directly on the element in one evaluate call,
  // so a marker DOM rebuild between locator reads can never split the pair.
  const markerX = () => marker.evaluate((node) => node.getBoundingClientRect().x);
  const before = await markerX();
  await page.waitForTimeout(10_000);
  await expect(marker).toBeVisible();
  const after = await markerX();
  expect(after).toBe(before);
  const refreshes = Number(await page.locator("#agent-annotations-root").getAttribute("data-marker-refreshes"));
  console.log(`dynamic-dom markerRefreshes10s=${refreshes}`);
  expect(refreshes).toBeLessThan(60);
  await shadow(page, '[aria-label^="Markers"]').click();
  await expect(shadow(page, ".aa-marker")).toHaveCount(0);
  const stopped = Number(await page.locator("#agent-annotations-root").getAttribute("data-marker-refreshes"));
  await page.waitForTimeout(500);
  expect(Number(await page.locator("#agent-annotations-root").getAttribute("data-marker-refreshes"))).toBe(stopped);
});
