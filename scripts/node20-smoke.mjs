// Goal 13/15 Node smoke: packs the exact tarball, installs it in a fresh
// consumer WITHOUT React, and runs both the /core import and the CLI under
// real Node 20 and Node 24 runtimes (npx node@20 / node@24). Fails loudly
// when the smoke breaks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args, cwd = root) => execFileSync("pnpm", args, { cwd, encoding: "utf8" });
const nodeVersion = (version, args, cwd) =>
  execFileSync("npx", ["-y", `node@${version}`, ...args], { cwd, encoding: "utf8" });

const temporary = mkdtempSync(path.join(tmpdir(), "agent-annotations-node20-smoke-"));
try {
  const packDir = path.join(temporary, "packed");
  mkdirSync(packDir, { recursive: true });
  run(["pack", "--pack-destination", packDir]);
  const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack did not produce a tarball");

  const consumer = path.join(temporary, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
    name: "node20-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
  }));
  writeFileSync(path.join(consumer, ".npmrc"), "auto-install-peers=false\n");
  run(["add", path.join(packDir, tarball)], consumer);

  writeFileSync(path.join(consumer, "core.mjs"), `
import { createAgentAnnotationsTask, parseAgentAnnotationsTask } from "@gchust/agent-annotations/core";
const task = createAgentAnnotationsTask({ taskId: "node20-core", createdAt: "2026-08-12T12:00:00.000Z", annotations: [] });
const parsed = parseAgentAnnotationsTask(JSON.parse(JSON.stringify(task)));
if (parsed.taskId !== "node20-core" || parsed.schema !== "agent-annotations.task.v1") {
  throw new Error("node20 core parse failed");
}
console.log("node20-core-ok " + process.version);
`);
  for (const version of ["20", "24"]) {
    const coreOutput = nodeVersion(version, ["core.mjs"], consumer);
    if (!coreOutput.includes(`node20-core-ok v${version}`)) {
      throw new Error(`node@${version} /core smoke failed: ${coreOutput}`);
    }
    console.log(coreOutput.trim());
    const cliOutput = nodeVersion(version, [
      "node_modules/@gchust/agent-annotations/dist/cli/index.mjs",
      "--help",
    ], consumer);
    if (!cliOutput.includes("Agent Annotations")) {
      throw new Error(`node@${version} CLI smoke failed: ${cliOutput}`);
    }
    console.log(`node${version}-cli-ok`);
  }
  console.log(`node20-smoke tarball: ${tarball}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
