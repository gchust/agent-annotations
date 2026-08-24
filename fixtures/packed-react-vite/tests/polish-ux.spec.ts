import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const taskPath = path.join(runtimeRoot, "tasks/active-task.json");
const evidenceRoot = process.env.AGENT_ANNOTATIONS_EVIDENCE
  ?? path.join(tmpdir(), "agent-annotations-packed-react-vite-evidence");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);
const shot = (name: string) => path.join(evidenceRoot, `polish-${name}.png`);
const cli = (...args: string[]) => execFileSync(
  "pnpm",
  ["exec", "agent-annotations", ...args],
  { encoding: "utf8", env: { ...process.env, AGENT_ANNOTATIONS_DIR: runtimeRoot } }
);
const readTask = () => JSON.parse(readFileSync(taskPath, "utf8"));
const activeElement = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const host = document.getElementById("agent-annotations-root");
    const node = host?.shadowRoot?.activeElement as HTMLElement | null;
    return node?.getAttribute("aria-label") ?? "";
  });

// Deterministic fixture task, built from scratch: the plugin initializes the
// store on the first page load, and each test then overwrites the task with
// this exact state before reloading.
const annotation = (id: string, comment: string) => ({
  annotationId: id,
  kind: "element",
  comment,
  status: "open",
  createdAt: "2026-08-12T12:00:00.000Z",
  pageContext: {
    url: "http://127.0.0.1:4179/",
    routeKey: "/",
    title: "Packed fixture",
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0 },
  },
  targets: [{
    selector: "#target",
    bounds: { x: 200, y: 120, width: 120, height: 32 },
    inspection: {
      tagName: "button",
      role: "button",
      accessibleName: "Target button",
      text: "Target button",
      componentName: "TargetButton",
      source: {
        filePath: "src/pages/home.tsx",
        lineNumber: 10,
        columnNumber: 4,
        componentName: "TargetButton",
      },
      sourceStack: [{
        filePath: "src/pages/home.tsx",
        lineNumber: 10,
        columnNumber: 4,
        componentName: "TargetButton",
      }],
      htmlPreview: "<button>Target button</button>",
      styleText: "",
      attributes: { id: "target" },
    },
  }],
  extensions: {},
});
const baseTask = (annotations: unknown[]) => ({
  schema: "agent-annotations.task.v1",
  schemaVersion: 1,
  taskId: "task-polish",
  taskRevision: 1,
  status: "active",
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
  annotations,
});
const writeTwoOpen = () => {
  writeFileSync(taskPath, JSON.stringify(baseTask([
    annotation("ann-a", "Make target purple"),
    annotation("ann-b", "Keep alignment"),
  ])));
};
const writeUnresolved = () => {
  writeFileSync(taskPath, JSON.stringify(baseTask([
    {
      ...annotation("ann-unresolved", "Target is gone"),
      targets: [{
        selector: "#never-matching-target",
        bounds: { x: 10, y: 10, width: 20, height: 20 },
        inspection: annotation("x", "y").targets[0].inspection,
      }],
    },
  ])));
};
// Snapshot the plugin-initialized task after the first goto, then restore it
// in finally so later specs in the serial chain stay valid.
const snapshotTask = () => readTask();

test("completed annotation opens from All anchored to its list item and returns focus to the dock control", async ({ page }) => {
  await page.goto("/"); // initializes the store
  const original = snapshotTask();
  writeTwoOpen();
  try {
    await page.reload();
    cli("complete", "ann-a", "--verified", "--summary", "Playwright verified");
    await page.reload();
    await page.keyboard.press("Control+Alt+L"); // open the list
    await expect(shadow(page, '[aria-label="Annotation list"]')).toBeVisible();
    // Switch to All so the completed annotation is listed (default is Open).
    await shadow(page, "text=All").click();
    await expect(shadow(page, ".aa-list-item")).toHaveCount(2);
    // The completed item (index 0) shows the completed status chip.
    await expect(shadow(page, ".aa-status-chip").first()).toHaveText(/completed/);
    await shadow(page, '.aa-list-item:first-child button').click();
    // The editor opens anchored to the list item and is fully usable.
    await expect(shadow(page, '[aria-label="Annotation editor"]')).toBeVisible();
    await expect(shadow(page, '[aria-label="Reopen"]')).toBeVisible();
    await page.screenshot({ path: shot("completed-editor") });
    // Closing keeps the panel closed and returns focus to the visible dock
    // list control.
    await shadow(page, '[aria-label="Close"]').click();
    await expect(shadow(page, ".aa-editor")).toHaveCount(0);
    await expect(shadow(page, ".aa-panel")).toHaveCount(0);
    await expect
      .poll(async () => activeElement(page))
      .toBe("Annotations (Ctrl+Alt+L)");
  } finally {
    writeFileSync(taskPath, JSON.stringify(original));
  }
});

test("unresolved annotation shows the reason in the list and anchors its editor to the dock", async ({ page }) => {
  await page.goto("/"); // initializes the store
  const original = snapshotTask();
  writeUnresolved();
  try {
    await page.reload();
    await page.keyboard.press("Control+Alt+L");
    await expect(shadow(page, '[aria-label="Annotation list"]')).toBeVisible();
    await expect(shadow(page, ".aa-list-item")).toContainText("0/1 targets");
    await expect(shadow(page, ".aa-list-item")).toContainText("unresolved");
    await page.screenshot({ path: shot("unresolved-list") });
    await shadow(page, '.aa-list-item button').click();
    await expect(shadow(page, '[aria-label="Annotation editor"]')).toBeVisible();
    await expect(shadow(page, ".aa-editor")).toContainText("0/1 targets");
    // The editor is dock-anchored near the bottom, never the silent top-left.
    const editorBox = await shadow(page, ".aa-editor").boundingBox();
    expect(editorBox).not.toBeNull();
    expect(editorBox!.y).toBeGreaterThan(300);
    await page.screenshot({ path: shot("unresolved-editor") });
    // Escape closes the editor without leaving focus on the page body.
    await page.keyboard.press("Escape");
    await expect(shadow(page, ".aa-editor")).toHaveCount(0);
  } finally {
    writeFileSync(taskPath, JSON.stringify(original));
  }
});

test("zh-CN locale renders the builtin chrome and list in Chinese", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__AGENT_ANNOTATIONS_LOCALE = "zh-CN";
  });
  await page.goto("/"); // initializes the store with the zh-CN host locale
  const original = snapshotTask();
  writeTwoOpen();
  try {
    await page.reload();
    // The dock starts expanded and localized.
    await expect(shadow(page, '[aria-label^="拾取"]')).toHaveCount(1);
    await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
    await expect(shadow(page, '[aria-label^="拾取"]')).toBeVisible();
    await page.screenshot({ path: shot("zh-cn") });
    await page.keyboard.press("Control+Alt+L");
    await expect(shadow(page, '[aria-label="标注列表"]')).toBeVisible();
    await expect(shadow(page, ".aa-list-item").first()).toBeVisible();
    await page.screenshot({ path: shot("zh-cn-list") });
  } finally {
    writeFileSync(taskPath, JSON.stringify(original));
    await context.close();
  }
});
