import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error release scripts are plain Node ESM, intentionally outside the TS build.
import { runVerificationSteps, verificationSteps } from "../../scripts/release-candidate.mjs";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const fixture = (directory: string) => ({
  tarball: path.join(directory, "candidate.tgz"),
  sha256: "ab".repeat(32),
  size: 1,
  files: ["package/package.json"],
  browserConsumer: path.join(directory, "browser-consumer"),
});

describe("release candidate verification", () => {
  it("passes one exact tarball path and SHA-256 to every candidate gate", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-annotations-release-plan-"));
    directories.push(directory);
    const candidate = fixture(directory);
    const steps = verificationSteps(candidate);
    expect(steps).toHaveLength(9);
    for (const step of steps) {
      expect(step.env).toMatchObject({
        AGENT_ANNOTATIONS_CANDIDATE_TARBALL: candidate.tarball,
        AGENT_ANNOTATIONS_CANDIDATE_SHA256: candidate.sha256,
        AGENT_ANNOTATIONS_CANDIDATE_CONSUMER: candidate.browserConsumer,
      });
    }
  });

  it("fails on a broken browser consumer while retaining candidate files and logs", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-annotations-release-failure-"));
    directories.push(directory);
    const candidate = fixture(directory);
    writeFileSync(candidate.tarball, "candidate");
    const run = vi.fn()
      .mockReturnValue({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "first-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "step-pass\n", stderr: "" })
      .mockReturnValueOnce({ status: 7, stdout: "", stderr: "consumer-failed\n" });

    expect(() => runVerificationSteps(candidate, run, directory)).toThrow("browser-consumer failed with exit 7");
    expect(readFileSync(candidate.tarball, "utf8")).toBe("candidate");
    expect(readFileSync(path.join(directory, "typecheck.log"), "utf8")).toContain("first-pass");
    expect(readFileSync(path.join(directory, "browser-consumer.log"), "utf8")).toContain("consumer-failed");
    expect(run).toHaveBeenCalledTimes(9);
  });
});
