import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = (args: string[], cwd: string): string =>
  execFileSync("pnpm", args, { cwd, encoding: "utf8" });

const packTarball = (temporary: string): string => {
  const directory = path.join(temporary, "packed");
  mkdirSync(directory, { recursive: true });
  // --config.ignore-scripts=true: dist is already built by pretest; running
  // prepack here would let tsdown clean:true transiently remove dist entries
  // while other Vitest files spawn the CLI from the live repo. The clean-dist
  // pack path stays covered by the pack-regression lifecycle test.
  run(["pack", "--config.ignore-scripts=true", "--pack-destination", directory], root);
  const tarball = readdirSync(directory, { encoding: "utf8" }).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack did not produce a tarball");
  return path.join(directory, tarball);
};

describe("core export and browser bundle", () => {
  it("keeps /core free of React, Vite, and Node imports in the built entry", () => {
    const entry = readFileSync(path.join(root, "dist/core/index.js"), "utf8");
    for (const forbidden of [/from "react/, /from "vite/, /node:/, /react-dom/]) {
      expect(entry).not.toMatch(forbidden);
    }
    // The whole declaration closure reachable from /core must be pure too:
    // no React/Vite/DOM/Node imports and no browser global type references.
    const declarations = readdirSync(path.join(root, "dist/core"), { recursive: true, encoding: "utf8" })
      .filter((file) => typeof file === "string" && file.endsWith(".d.ts"));
    const imported = new Set<string>();
    const pending = [...declarations];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (imported.has(file)) continue;
      imported.add(file);
      const content = readFileSync(path.join(root, "dist/core", file), "utf8");
      expect(content).not.toMatch(/from\s+["'][^"']*(?:react|vite)|node:|react-dom/);
      expect(content).not.toMatch(/\b(?:Document|Window|HTMLElement|ShadowRoot)\b/);
      for (const match of content.matchAll(/from\s+["'](\.\/[^"']+\.d\.ts)["']/g)) {
        const target = path.normalize(path.join(path.dirname(file), match[1]!));
        if (target.startsWith("../") && target.endsWith(".d.ts")) pending.push(target);
      }
    }
  });

  it("removes react-dom/server from every built browser artifact", () => {
    const scan = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) scan(absolute);
        else if (/\.(?:js|mjs)$/.test(entry.name)) {
          expect(readFileSync(absolute, "utf8")).not.toContain("react-dom/server");
        }
      }
    };
    scan(path.join(root, "dist"));
  });

  it("lets an exact-tarball consumer import and run /core with React absent", { timeout: 240_000 }, () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "agent-annotations-core-consumer-"));
    try {
      const tarball = packTarball(temporary);
      const consumer = path.join(temporary, "consumer");
      mkdirSync(consumer, { recursive: true });
      writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
        name: "core-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      }));
      // No React/React DOM anywhere in this consumer.
      writeFileSync(path.join(consumer, ".npmrc"), "auto-install-peers=false\n");
      run(["add", tarball], consumer);
      expect(existsSync(path.join(consumer, "node_modules/react"))).toBe(false);
      expect(existsSync(path.join(consumer, "node_modules/react-dom"))).toBe(false);
      const script = `
import { createAgentAnnotationsTask, parseAgentAnnotationsTask } from "@gchust/agent-annotations/core";
import { redactAgentAnnotationsText } from "@gchust/agent-annotations/core";
const task = createAgentAnnotationsTask({
  taskId: "core-consumer-1",
  createdAt: "2026-08-12T12:00:00.000Z",
  annotations: [],
});
const parsed = parseAgentAnnotationsTask(JSON.parse(JSON.stringify(task)));
if (parsed.taskId !== "core-consumer-1" || parsed.schema !== "agent-annotations.task.v1") {
  throw new Error("core parse failed");
}
const redacted = redactAgentAnnotationsText("Bearer UNIQUE_CORE_SECRET", { maxLength: 500 });
if (redacted.includes("UNIQUE_CORE_SECRET")) throw new Error("core redaction failed");
if (!redacted.includes("[REDACTED]")) throw new Error("core redaction marker missing");
console.log("core-consumer-ok");
`;
      writeFileSync(path.join(consumer, "run.mjs"), script);
      const output = execFileSync(process.execPath, ["run.mjs"], { cwd: consumer, encoding: "utf8" });
      expect(output).toContain("core-consumer-ok");
      // TypeScript consumer evidence: a typecheck against the /core
      // declarations succeeds with React types absent from the consumer.
      run(["add", "typescript@5.7.3"], consumer);
      writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["check.ts"],
      }));
      writeFileSync(path.join(consumer, "check.ts"), `
import { createAgentAnnotationsTask, parseAgentAnnotationsTask } from "@gchust/agent-annotations/core";
const task = createAgentAnnotationsTask({
  taskId: "typed-core",
  createdAt: "2026-08-12T12:00:00.000Z",
  annotations: [],
});
const parsed: import("@gchust/agent-annotations/core").AgentAnnotationsTask = parseAgentAnnotationsTask(task);
void parsed;
`);
      const tsc = execFileSync(
        process.execPath,
        ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
        { cwd: consumer, encoding: "utf8" }
      );
      expect(tsc).not.toContain("error");
      expect(existsSync(path.join(consumer, "node_modules/react"))).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("exposes every export target in the tarball", { timeout: 240_000 }, () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "agent-annotations-core-tarball-"));
    try {
      const tarball = packTarball(temporary);
      const files = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
        .split("\n").map((file) => file.trim().replace(/^package\//, "")).filter(Boolean);
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        exports: Record<string, Record<string, string>>;
      };
      for (const key of Object.keys(manifest.exports)) {
        const conditions = manifest.exports[key]!;
        for (const value of Object.values(conditions)) {
          expect(files).toContain(value.replace(/^\.\//, ""));
        }
      }
      expect(files).toContain("dist/core/index.js");
      expect(files).toContain("dist/core/index.d.ts");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("excludes the runtime marker from a real packed production consumer build", { timeout: 300_000 }, () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "agent-annotations-core-prod-"));
    try {
      const tarball = packTarball(temporary);
      const consumer = path.join(temporary, "consumer");
      cpSync(path.join(root, "fixtures/packed-react-vite"), consumer, {
        recursive: true,
        filter(source) {
          const relative = path.relative(path.join(root, "fixtures/packed-react-vite"), source);
          return !relative.split(path.sep).some((part) =>
            ["node_modules", "dist", ".agent-annotations", "test-results", "playwright-report"].includes(part));
        },
      });
      writeFileSync(path.join(consumer, "gchust-agent-annotations.tgz"), readFileSync(tarball));
      run(["install", "--lockfile-only", "--ignore-scripts"], consumer);
      run(["install", "--frozen-lockfile"], consumer);
      run(["build"], consumer);
      const walk = (directory: string, found: string[]): string[] => {
        for (const entry of readdirSync(directory, { encoding: "utf8", withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(absolute, found);
          else if (/\.(?:js|mjs|html)$/.test(entry.name)) found.push(absolute);
        }
        return found;
      };
      const assets = walk(path.join(consumer, "dist"), []);
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        const content = readFileSync(asset, "utf8");
        // The runtime (and its host element marker) is serve-only and must
        // never reach a production consumer bundle.
        expect(content).not.toContain("agent-annotations-root");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
