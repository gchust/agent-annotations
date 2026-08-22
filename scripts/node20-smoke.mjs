// Goal 13/15 Node smoke: packs the exact tarball, installs it in a fresh
// consumer WITHOUT React, and runs both the /core import and the CLI under
// real Node 20 and Node 24 runtimes (npx node@20 / node@24). Fails loudly
// when the smoke breaks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args, cwd = root) => execFileSync("pnpm", args, { cwd, encoding: "utf8" });
const nodeVersion = (version, args, cwd) =>
  execFileSync("npx", ["-y", `node@${version}`, ...args], { cwd, encoding: "utf8" });

const exactTarball = process.argv[2] ? path.resolve(process.argv[2]) : null;
const expectedSha256 = process.argv[3];
const temporary = process.argv[4] ? path.resolve(process.argv[4]) : mkdtempSync(path.join(tmpdir(), "agent-annotations-node20-smoke-"));
const preserve = Boolean(process.argv[4]);
try {
  let candidate = exactTarball;
  if (!candidate) {
    const packDir = path.join(temporary, "packed");
    mkdirSync(packDir, { recursive: true });
    run(["pack", "--pack-destination", packDir]);
    const packed = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (!packed) throw new Error("pnpm pack did not produce a tarball");
    candidate = path.join(packDir, packed);
  }
  const actualSha256 = createHash("sha256").update(readFileSync(candidate)).digest("hex");
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error("release candidate SHA-256 mismatch");

  const consumer = path.join(temporary, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
    name: "node20-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
  }));
  writeFileSync(path.join(consumer, ".npmrc"), "auto-install-peers=false\n");
  run(["add", candidate], consumer);

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
  console.log(`node20-smoke tarball: ${candidate} sha256 ${actualSha256}`);
} finally {
  if (!preserve) rmSync(temporary, { recursive: true, force: true });
}
