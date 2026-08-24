import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const runtimeRoot = path.resolve(".agent-annotations");
const shadow = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(`#agent-annotations-root >> ${selector}`);
// Authoritative packed run: the fixture dev server starts with
// AGENT_ANNOTATIONS_PACKED_BASE=/app/ (playwright.relative-base.config.ts),
// proving the runtime mounts, routes, and persists under a non-root base.
const base = process.env.AGENT_ANNOTATIONS_PACKED_BASE ?? "/app/";

test("runtime mounts, routes, and persists a session under the active base", async ({ page }) => {
  await page.goto(`${base}`);
  await expect(shadow(page, ".aa-dock")).toBeVisible();
  await expect(shadow(page, ".aa-dock")).toHaveAttribute("data-collapsed", "false");
  const session = JSON.parse(readFileSync(path.join(runtimeRoot, "session.json"), "utf8"));
  expect(session).toHaveProperty("token");
  // The expanded toolbar renders under the base.
  await expect(shadow(page, '[aria-label^="Pick"]')).toBeVisible();
});
