import { spawnSync } from "node:child_process";

// Local stability gate: run the packed consumer E2E a fixed number of times as
// independent foreground executions. Any single failure fails the command; a
// failure is never retried or swallowed. This is the entry point for validating
// that a packed E2E is stable without "rerun until green".
const RUNS = 5;

for (let index = 1; index <= RUNS; index += 1) {
  const started = Date.now();
  const result = spawnSync("pnpm", ["test:e2e"], { stdio: "inherit" });
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
