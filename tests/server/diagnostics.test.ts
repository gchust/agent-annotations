import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendDiagnostics,
  clearDiagnostics,
  DIAGNOSTICS_FILE,
  MAX_DIAGNOSTICS_BYTES,
  readDiagnostics,
} from "../../src/server/diagnostics.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "agent-annotations-diagnostics-"));
  roots.push(value);
  return value;
};

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

describe("persisted diagnostics", () => {
  it("writes a private atomic diagnostics file and reads it back", () => {
    const dir = root();
    const entries = appendDiagnostics(dir, [
      { source: "console", message: "first", timestamp: "2026-08-12T12:00:00.000Z" },
      { source: "window", message: "second", timestamp: "2026-08-12T12:00:01.000Z" },
    ]);
    expect(entries.map(({ message }) => message)).toEqual(["first", "second"]);
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).mode & 0o777).toBe(0o600);
    expect(readDiagnostics(dir).map(({ message }) => message)).toEqual(["first", "second"]);
    expect(readFileSync(path.join(dir, DIAGNOSTICS_FILE), "utf8")).not.toContain(".tmp");
  });

  it("redacts secrets and bounds entries, messages, and file size at the boundary", () => {
    const dir = root();
    const entries = appendDiagnostics(dir, [
      { source: "console", message: "Bearer UNIQUE_SECRET_SENTINEL_diag", timestamp: "2026-08-12T12:00:00.000Z" },
      { source: "promise", message: "x".repeat(2_000), timestamp: "2026-08-12T12:00:01.000Z" },
    ]);
    expect(entries[0]!.message).not.toContain("UNIQUE_SECRET_SENTINEL_diag");
    expect(entries[0]!.message).toContain("[REDACTED]");
    expect(entries[1]!.message.length).toBeLessThanOrEqual(512);
    for (let index = 0; index < 30; index += 1) {
      appendDiagnostics(dir, [{
        source: "console",
        message: `bounded-${index}`,
        timestamp: "2026-08-12T12:00:00.000Z",
      }]);
    }
    expect(readDiagnostics(dir)).toHaveLength(20);
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).size)
      .toBeLessThanOrEqual(MAX_DIAGNOSTICS_BYTES);
  });

  it("safely returns empty for an oversized existing file and clear restores it", () => {
    const dir = root();
    writeFileSync(
      path.join(dir, DIAGNOSTICS_FILE),
      JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
        source: "console",
        message: "x".repeat(1_000),
        timestamp: "2026-08-12T12:00:00.000Z",
      })))
    );
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).size).toBeGreaterThan(MAX_DIAGNOSTICS_BYTES);
    expect(readDiagnostics(dir)).toEqual([]);
    clearDiagnostics(dir);
    expect(readDiagnostics(dir)).toEqual([]);
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).size)
      .toBeLessThanOrEqual(MAX_DIAGNOSTICS_BYTES);
  });

  it("accepts extension entries with bounded locate-able fields", () => {
    const dir = root();
    const entries = appendDiagnostics(dir, [{
      source: "extension",
      message: "execute failed for demo.extension:boom",
      timestamp: "2026-08-12T12:00:00.000Z",
      extensionId: "demo.extension",
      contributionId: "demo.extension:run",
      phase: "execute",
    }]);
    expect(entries[0]).toMatchObject({
      source: "extension",
      extensionId: "demo.extension",
      contributionId: "demo.extension:run",
      phase: "execute",
    });
    const persisted = readDiagnostics(dir);
    expect(persisted[0]!.extensionId).toBe("demo.extension");
    expect(persisted[0]!.phase).toBe("execute");
    expect(JSON.stringify(persisted)).not.toContain("secret");
  });

  it("rejects invalid extension fields, arbitrary phases, and oversize ids", () => {
    const dir = root();
    const base = { source: "extension", message: "x", timestamp: "2026-08-12T12:00:00.000Z" };
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: 7, phase: "setup" }]))
      .toThrow("invalid extensionId");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "", phase: "setup" }]))
      .toThrow("invalid extensionId");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "x".repeat(65), phase: "setup" }]))
      .toThrow("invalid extensionId");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: "setup", contributionId: 7 }]))
      .toThrow("invalid contributionId");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: "spawn" }]))
      .toThrow("invalid phase");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: 1 }]))
      .toThrow("invalid phase");
    expect(() => appendDiagnostics(dir, [{ ...base, phase: "setup" }]))
      .toThrow("invalid extensionId");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "ext" }]))
      .toThrow("invalid phase");
    expect(() => appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: "setup" }])).not.toThrow();
    // Non-extension sources reject extension-only fields.
    const consoleBase = { source: "console", message: "x", timestamp: "2026-08-12T12:00:00.000Z" };
    expect(() => appendDiagnostics(dir, [{ ...consoleBase, extensionId: "ext", phase: "execute" }]))
      .toThrow("invalid extension fields");
    expect(() => appendDiagnostics(dir, [{ ...consoleBase, phase: "execute" }]))
      .toThrow("invalid extension fields");
    expect(() => appendDiagnostics(dir, [consoleBase])).not.toThrow();
  });

  it("accepts the longest canonical contribution id from a bounded registry", () => {
    const dir = root();
    const canonical = `${"a".repeat(64)}:${"b".repeat(64)}`;
    expect(canonical.length).toBeLessThanOrEqual(129);
    const entries = appendDiagnostics(dir, [{
      source: "extension",
      message: "execute failed",
      timestamp: "2026-08-12T12:00:00.000Z",
      extensionId: "a".repeat(64),
      contributionId: canonical,
      phase: "execute",
    }]);
    expect(entries[0]!.contributionId).toBe(canonical);
    expect(readDiagnostics(dir)[0]!.contributionId).toBe(canonical);
  });

  it("rejects invalid sources, non-string messages, and bad timestamps", () => {
    const dir = root();
    expect(() => appendDiagnostics(dir, [
      { source: "network" as never, message: "x", timestamp: "2026-08-12T12:00:00.000Z" },
    ])).toThrow();
    expect(() => appendDiagnostics(dir, [
      { source: "console", message: 42 as never, timestamp: "2026-08-12T12:00:00.000Z" },
    ])).toThrow();
    expect(() => appendDiagnostics(dir, [
      { source: "console", message: "x", timestamp: "not-a-timestamp" },
    ])).toThrow();
    expect(readDiagnostics(dir)).toEqual([]);
  });

  it("drops extra secret-bearing fields at the boundary", () => {
    const dir = root();
    const entries = appendDiagnostics(dir, [{
      source: "console",
      message: "visible",
      timestamp: "2026-08-12T12:00:00.000Z",
      authorization: "Bearer SECRET_AUTH",
      cookie: "session=SECRET_COOKIE",
      requestBody: "SECRET_BODY",
      responseBody: "SECRET_BODY",
      formValue: "SECRET_FORM",
    } as never]);
    expect(entries[0]).toEqual({
      source: "console",
      message: "visible",
      timestamp: "2026-08-12T12:00:00.000Z",
    });
    expect(JSON.stringify(readDiagnostics(dir))).not.toContain("SECRET");
  });

  it("clears only diagnostics and leaves the task untouched", () => {
    const dir = root();
    appendDiagnostics(dir, [{
      source: "console",
      message: "keep-me",
      timestamp: "2026-08-12T12:00:00.000Z",
    }]);
    clearDiagnostics(dir);
    expect(readDiagnostics(dir)).toEqual([]);
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).mode & 0o777).toBe(0o600);
  });
});
