import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// AGENT_ANNOTATIONS_PACKED_FIXTURE lets release tests run this exact gate
// against a temporary fixture copy; production/CI always uses the repo fixture.
const fixture = process.env.AGENT_ANNOTATIONS_PACKED_FIXTURE
  ? path.resolve(process.env.AGENT_ANNOTATIONS_PACKED_FIXTURE)
  : path.join(root, "fixtures/packed-react-vite");
const exactTarball = process.env.AGENT_ANNOTATIONS_CANDIDATE_TARBALL;
const expectedSha256 = process.env.AGENT_ANNOTATIONS_CANDIDATE_SHA256;
const exactConsumer = process.env.AGENT_ANNOTATIONS_CANDIDATE_CONSUMER;
if ([exactTarball, expectedSha256, exactConsumer].some(Boolean)
  && ![exactTarball, expectedSha256, exactConsumer].every(Boolean)) {
  throw new Error("exact packed E2E requires candidate tarball, SHA-256, and consumer together");
}
const temporary = exactConsumer ? path.dirname(exactConsumer) : mkdtempSync(path.join(tmpdir(), "agent-annotations-packed-e2e-"));
const consumer = exactConsumer ?? path.join(temporary, "consumer");
const tarball = path.join(consumer, "gchust-agent-annotations.tgz");
const generated = new Set(["node_modules", "dist", ".agent-annotations", "playwright-report", "test-results"]);
const bypass = [process.env.NO_PROXY, "localhost", "127.0.0.1"].filter(Boolean).join(",");
const env = {
  ...process.env,
  NO_PROXY: bypass,
  no_proxy: bypass,
  AGENT_ANNOTATIONS_EVIDENCE: process.env.AGENT_ANNOTATIONS_EVIDENCE
    ?? path.join(temporary, "evidence"),
};
const run = (args, cwd = root, stdio = "inherit") =>
  execFileSync("pnpm", args, { cwd, env, stdio, encoding: "utf8" });

let passed = false;
try {
  if (!exactConsumer) cpSync(fixture, consumer, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixture, source);
      return !relative.split(path.sep).some((part) => generated.has(part))
        && path.basename(source) !== "pnpm-lock.yaml"
        && !/[.](?:tgz|png|zip|log)$/.test(source);
    },
  });
  if (exactTarball) {
    const actualSha256 = createHash("sha256").update(readFileSync(exactTarball)).digest("hex");
    if (!expectedSha256 || actualSha256 !== expectedSha256) throw new Error("release candidate SHA-256 mismatch");
    cpSync(exactTarball, tarball);
    console.log(`[agent-annotations] exact packed E2E candidate sha256 ${actualSha256}`);
  } else {
    run(["build"]);
    const packed = run(["pack", "--json", "--out", tarball], root, "pipe");
    process.stdout.write(packed);
  }
  if (!existsSync(tarball)) throw new Error("pnpm pack did not create the consumer-local tarball");
  if (!existsSync(path.join(consumer, "node_modules"))) {
    run(["install", "--lockfile-only", "--ignore-scripts"], consumer);
    run(["install", "--frozen-lockfile"], consumer);
  }
  run(["test:e2e"], consumer);
  passed = true;
} finally {
  if (passed) {
    if (!exactConsumer) rmSync(temporary, { recursive: true, force: true });
  } else {
    console.error(`[agent-annotations] preserved failed packed E2E consumer: ${consumer}`);
  }
}
