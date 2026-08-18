import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = (args: string[], cwd: string) => execFileSync("pnpm", args, { cwd, encoding: "utf8" });

describe("pack lifecycle regression", () => {
  it("packs a complete tarball from a clean dist-less checkout", { timeout: 240_000 }, () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "agent-annotations-pack-regression-"));
    try {
      const checkout = path.join(temporary, "checkout");
      cpSync(root, checkout, {
        recursive: true,
        filter(source) {
          const relative = path.relative(root, source);
          return !relative.split(path.sep).some((part) => ["node_modules", ".git", "dist", "test-results", "playwright-report"].includes(part));
        },
      });
      symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"), "dir");
      rmSync(path.join(checkout, "dist"), { recursive: true, force: true });
      expect(existsSync(path.join(checkout, "dist"))).toBe(false);

      const destination = path.join(temporary, "packed");
      run(["pack", "--pack-destination", destination], checkout);
      const tarball = readdirSync(destination).find((file) => file.endsWith(".tgz"));
      expect(tarball).toBeDefined();
      const tarballPath = path.join(destination, tarball!);
      expect(existsSync(tarballPath)).toBe(true);
      expect(existsSync(path.join(checkout, "dist/cli/index.mjs"))).toBe(true);

      const files = execFileSync("tar", ["-tf", tarballPath], { encoding: "utf8" })
        .split("\n").map((file) => file.trim().replace(/^package\//, "")).filter(Boolean).sort();
      const manifest = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8")) as {
        exports: Record<string, Record<string, string>>;
        bin: Record<string, string>;
      };
      for (const conditions of Object.values(manifest.exports)) {
        for (const value of Object.values(conditions)) {
          expect(files).toContain(value.replace(/^\.\//, ""));
        }
      }
      for (const file of Object.values(manifest.bin)) {
        expect(files).toContain(file.replace(/^\.\//, ""));
      }
      for (const file of files) {
        expect(file).not.toMatch(/^(?:src|tests|fixtures|playgrounds|scripts)\//);
        expect(file).not.toMatch(/\.map$/);
      }
      expect(JSON.stringify(manifest)).not.toContain("workspace:");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
