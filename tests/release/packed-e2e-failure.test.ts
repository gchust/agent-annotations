import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const generated = ["node_modules", ".git", "dist", "test-results", "playwright-report"];
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

describe("packed E2E failure propagation", () => {
  it("exits non-zero when a single packed E2E spec fails", { timeout: 300_000 }, () => {
    // Run the real packed-e2e gate from a hermetic repo copy so its build never
    // races other tests that spawn the root dist. The copy mirrors the
    // clean-checkout pattern used by the pack regression suite.
    const checkout = mkdtempSync(path.join(tmpdir(), "agent-annotations-packed-e2e-failure-"));
    roots.push(checkout);
    cpSync(root, checkout, {
      recursive: true,
      filter(source) {
        const relative = path.relative(root, source);
        return !relative.split(path.sep).some((part) => generated.includes(part));
      },
    });
    symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"), "dir");
    rmSync(path.join(checkout, "dist"), { recursive: true, force: true });

    // Sabotage a throwaway fixture copy: one deterministic Playwright failure.
    const fixture = mkdtempSync(path.join(tmpdir(), "agent-annotations-failing-fixture-"));
    roots.push(fixture);
    cpSync(path.join(checkout, "fixtures/packed-react-vite"), fixture, {
      recursive: true,
      filter(source) {
        const relative = path.relative(path.join(checkout, "fixtures/packed-react-vite"), source);
        return !relative.split(path.sep).some((part) => ["node_modules", "dist", ".agent-annotations", "playwright-report", "test-results"].includes(part))
          && path.basename(source) !== "pnpm-lock.yaml"
          && !/[.](?:tgz|png|zip|log)$/.test(source);
      },
    });
    const manifestPath = path.join(fixture, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    writeFileSync(manifestPath, `${JSON.stringify({
      ...manifest,
      scripts: { ...manifest.scripts, "test:e2e": "playwright test tests/failing.spec.ts" },
    }, null, 2)}\n`);
    mkdirSync(path.join(fixture, "tests"), { recursive: true });
    writeFileSync(path.join(fixture, "tests", "failing.spec.ts"), `
import { expect, test } from "@playwright/test";

test("single packed E2E failure", () => {
  expect(1).toBe(2);
});
`);

    const script = path.join(checkout, "scripts/packed-e2e.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: checkout,
      env: { ...process.env, AGENT_ANNOTATIONS_PACKED_FIXTURE: fixture },
      encoding: "utf8",
      timeout: 300_000,
    });
    expect(result.error).toBeUndefined();
    // A single failed spec must fail the packed E2E gate; it must never be
    // retried or swallowed into a green exit.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preserved failed packed E2E consumer");
  });
});
