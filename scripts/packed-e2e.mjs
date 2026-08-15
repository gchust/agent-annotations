import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(root, "fixtures/packed-react-vite");
const temporary = mkdtempSync(path.join(tmpdir(), "agent-feedback-packed-e2e-"));
const consumer = path.join(temporary, "consumer");
const tarball = path.join(consumer, "gchust-agent-annotations.tgz");
const generated = new Set(["node_modules", "dist", ".agent-feedback", "playwright-report", "test-results"]);
const bypass = [process.env.NO_PROXY, "localhost", "127.0.0.1"].filter(Boolean).join(",");
const env = {
  ...process.env,
  NO_PROXY: bypass,
  no_proxy: bypass,
  AGENT_FEEDBACK_EVIDENCE: path.join(temporary, "evidence"),
};
const run = (args, cwd = root, stdio = "inherit") =>
  execFileSync("pnpm", args, { cwd, env, stdio, encoding: "utf8" });

let passed = false;
try {
  cpSync(fixture, consumer, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixture, source);
      return !relative.split(path.sep).some((part) => generated.has(part))
        && path.basename(source) !== "pnpm-lock.yaml"
        && !/[.](?:tgz|png|zip|log)$/.test(source);
    },
  });
  run(["build"]);
  const packed = run(["pack", "--json", "--out", tarball], root, "pipe");
  process.stdout.write(packed);
  if (!existsSync(tarball)) throw new Error("pnpm pack did not create the consumer-local tarball");
  run(["install", "--lockfile-only", "--ignore-scripts"], consumer);
  run(["install", "--frozen-lockfile"], consumer);
  run(["test:e2e"], consumer);
  passed = true;
} finally {
  if (passed) rmSync(temporary, { recursive: true, force: true });
  else console.error(`[agent-feedback] preserved failed packed E2E consumer: ${consumer}`);
}
