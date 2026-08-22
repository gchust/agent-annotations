import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { candidateEnvironment, loadCandidate } from "./release-candidate.mjs";

// Local stability gate: run the packed consumer E2E a fixed number of times as
// independent foreground executions. Any single failure fails the command; a
// failure is never retried or swallowed. This is the entry point for validating
// that a packed E2E is stable without "rerun until green".
const RUNS = 5;
const candidate = loadCandidate();
const env = { ...process.env, ...candidateEnvironment(candidate) };

console.log(`[agent-annotations] repeated E2E candidate sha256 ${candidate.sha256}`);

for (let index = 1; index <= RUNS; index += 1) {
  rmSync(path.join(candidate.browserConsumer, ".agent-annotations"), { recursive: true, force: true });
  const started = Date.now();
  const result = spawnSync("pnpm", ["test:e2e"], {
    cwd: candidate.browserConsumer,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `[agent-annotations] candidate sha256 ${candidate.sha256}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(path.dirname(candidate.tarball), `repeat-e2e-${index}.log`), output);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`[agent-annotations] packed E2E run ${index}/${RUNS}: PASS (${seconds}s)`);
    continue;
  }
  console.error(
    `[agent-annotations] packed E2E run ${index}/${RUNS}: FAILED ` +
      `(exit=${result.status ?? "signal:" + (result.signal ?? "unknown")}, ${seconds}s)`
  );
  process.exit(1);
}
console.log(`[agent-annotations] packed E2E repeated ${RUNS} times: all PASS`);
