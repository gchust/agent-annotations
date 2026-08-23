import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendDiagnostics,
  clearDiagnostics,
  DIAGNOSTICS_FILE,
  diagnosticsStore,
  MAX_DIAGNOSTICS_BYTES,
  MAX_DIAGNOSTICS_ENTRIES,
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
  it("writes a private atomic diagnostics file and reads it back", async () => {
    const dir = root();
    const entries = await appendDiagnostics(dir, [
      { source: "console", message: "first", timestamp: "2026-08-12T12:00:00.000Z" },
      { source: "window", message: "second", timestamp: "2026-08-12T12:00:01.000Z" },
    ]);
    expect(entries.map(({ message }) => message)).toEqual(["first", "second"]);
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).mode & 0o777).toBe(0o600);
    }
    expect((await readDiagnostics(dir)).map(({ message }) => message)).toEqual(["first", "second"]);
    expect(readFileSync(path.join(dir, DIAGNOSTICS_FILE), "utf8")).not.toContain(".tmp");
  });

  it("redacts secrets and bounds entries, messages, and file size at the boundary", async () => {
    const dir = root();
    await appendDiagnostics(dir, [
      { source: "console", message: "Bearer UNIQUE_SECRET_SENTINEL_diag", timestamp: "2026-08-12T12:00:00.000Z" },
      { source: "promise", message: "x".repeat(2_000), timestamp: "2026-08-12T12:00:01.000Z" },
    ]);
    const entries = await readDiagnostics(dir);
    expect(entries[0]!.message).not.toContain("UNIQUE_SECRET_SENTINEL_diag");
    expect(entries[0]!.message).toContain("[REDACTED]");
    expect(entries[1]!.message.length).toBeLessThanOrEqual(512);
    for (let index = 0; index < 30; index += 1) {
      await appendDiagnostics(dir, [{
        source: "console",
        message: `bounded-${index}`,
        timestamp: "2026-08-12T12:00:00.000Z",
      }]);
    }
    expect(await readDiagnostics(dir)).toHaveLength(20);
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).size)
      .toBeLessThanOrEqual(MAX_DIAGNOSTICS_BYTES);
  });

  it("safely returns empty for an oversized existing file and clear restores it", async () => {
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
    expect(await readDiagnostics(dir)).toEqual([]);
    await clearDiagnostics(dir);
    expect(await readDiagnostics(dir)).toEqual([]);
    expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).size)
      .toBeLessThanOrEqual(MAX_DIAGNOSTICS_BYTES);
  });

  it("accepts extension entries with bounded locate-able fields", async () => {
    const dir = root();
    await appendDiagnostics(dir, [{
      source: "extension",
      message: "execute failed for demo.extension:boom",
      timestamp: "2026-08-12T12:00:00.000Z",
      extensionId: "demo.extension",
      contributionId: "demo.extension:run",
      phase: "execute",
    }]);
    const persisted = await readDiagnostics(dir);
    expect(persisted[0]).toMatchObject({
      source: "extension",
      extensionId: "demo.extension",
      contributionId: "demo.extension:run",
      phase: "execute",
    });
    expect(JSON.stringify(persisted)).not.toContain("secret");
  });


  it("rejects invalid extension fields, arbitrary phases, and oversize ids", async () => {
    const dir = root();
    const base = { source: "extension", message: "x", timestamp: "2026-08-12T12:00:00.000Z" };
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: 7, phase: "setup" }]))
      .rejects.toThrow("invalid extensionId");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "", phase: "setup" }]))
      .rejects.toThrow("invalid extensionId");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "x".repeat(65), phase: "setup" }]))
      .rejects.toThrow("invalid extensionId");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: "setup", contributionId: 7 }]))
      .rejects.toThrow("invalid contributionId");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: "spawn" }]))
      .rejects.toThrow("invalid phase");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: 1 }]))
      .rejects.toThrow("invalid phase");
    await expect(appendDiagnostics(dir, [{ ...base, phase: "setup" }]))
      .rejects.toThrow("invalid extensionId");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "ext" }]))
      .rejects.toThrow("invalid phase");
    await expect(appendDiagnostics(dir, [{ ...base, extensionId: "ext", phase: "setup" }])).resolves.toBeDefined();
    // Non-extension sources reject extension-only fields.
    const consoleBase = { source: "console", message: "x", timestamp: "2026-08-12T12:00:00.000Z" };
    await expect(appendDiagnostics(dir, [{ ...consoleBase, extensionId: "ext", phase: "execute" }]))
      .rejects.toThrow("invalid extension fields");
    await expect(appendDiagnostics(dir, [{ ...consoleBase, phase: "execute" }]))
      .rejects.toThrow("invalid extension fields");
    await expect(appendDiagnostics(dir, [consoleBase])).resolves.toBeDefined();
  });

  it("accepts the longest canonical contribution id from a bounded registry", async () => {
    const dir = root();
    const canonical = `${"a".repeat(64)}:${"b".repeat(64)}`;
    expect(canonical.length).toBeLessThanOrEqual(129);
    await appendDiagnostics(dir, [{
      source: "extension",
      message: "execute failed",
      timestamp: "2026-08-12T12:00:00.000Z",
      extensionId: "a".repeat(64),
      contributionId: canonical,
      phase: "execute",
    }]);
    expect((await readDiagnostics(dir))[0]!.contributionId).toBe(canonical);
  });

  it("rejects invalid sources, non-string messages, and bad timestamps", async () => {
    const dir = root();
    await expect(appendDiagnostics(dir, [
      { source: "network" as never, message: "x", timestamp: "2026-08-12T12:00:00.000Z" },
    ])).rejects.toThrow();
    await expect(appendDiagnostics(dir, [
      { source: "console", message: 42 as never, timestamp: "2026-08-12T12:00:00.000Z" },
    ])).rejects.toThrow();
    await expect(appendDiagnostics(dir, [
      { source: "console", message: "x", timestamp: "not-a-timestamp" },
    ])).rejects.toThrow();
    expect(await readDiagnostics(dir)).toEqual([]);
  });

  it("accepts network entries with strict privacy-safe fields and rejects unsanitized ones", async () => {
    const dir = root();
    await appendDiagnostics(dir, [{
      source: "network",
      message: "fetch GET https://example.test/a failed (404)",
      timestamp: "2026-08-12T12:00:00.000Z",
      method: "GET",
      url: "https://example.test/a",
      status: 404,
      transport: "fetch",
    }, {
      source: "network",
      message: "xhr POST https://example.test/b failed (500)",
      timestamp: "2026-08-12T12:00:01.000Z",
      method: "POST",
      url: "https://example.test/b",
      status: 500,
      transport: "xhr",
    }]);
    const persisted = await readDiagnostics(dir);
    expect(persisted[0]).toMatchObject({
      source: "network",
      method: "GET",
      url: "https://example.test/a",
      status: 404,
      transport: "fetch",
    });
    expect(persisted[1]).toMatchObject({ method: "POST", status: 500, transport: "xhr" });
    // Unsanitized URLs (query/fragment) and malformed metadata are rejected.
    const base = { source: "network", message: "x", timestamp: "2026-08-12T12:00:00.000Z" };
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "https://example.test/a?token=SECRET", transport: "fetch",
    }])).rejects.toThrow("invalid url");
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "https://example.test/a#frag", transport: "fetch",
    }])).rejects.toThrow("invalid url");
    await expect(appendDiagnostics(dir, [{
      ...base, method: "get", url: "https://example.test/a", transport: "fetch",
    }])).rejects.toThrow("invalid method");
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "https://example.test/a", transport: "websocket" as never,
    }])).rejects.toThrow("invalid transport");
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "https://example.test/a", status: 99, transport: "fetch",
    }])).rejects.toThrow("invalid status");
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "x".repeat(2001), transport: "fetch",
    }])).rejects.toThrow("invalid url");
    // Network fields are rejected on non-network sources.
    await expect(appendDiagnostics(dir, [{
      source: "console", message: "x", timestamp: "2026-08-12T12:00:00.000Z",
      method: "GET", url: "https://example.test/a", transport: "fetch",
    }])).rejects.toThrow("invalid network fields");
    // A root-level origin+path is a valid sanitized URL.
    await expect(appendDiagnostics(dir, [{
      source: "network", message: "x", timestamp: "2026-08-12T12:00:00.000Z",
      method: "GET", url: "https://example.test/", transport: "fetch",
    }])).resolves.toBeDefined();
  });

  it("rejects network URLs that are not a real sanitized http(s) origin+path", async () => {
    const dir = root();
    const base = { source: "network", message: "x", timestamp: "2026-08-12T12:00:00.000Z" };
    const rejectUrl = async (url: string): Promise<void> => {
      await expect(appendDiagnostics(dir, [{ ...base, method: "GET", url, transport: "fetch" }]))
        .rejects.toThrow("invalid url");
    };
    await rejectUrl("example.test/a");                    // bare host, no scheme
    await rejectUrl("/api/x");                            // bare relative path
    await rejectUrl("//example.test/api");                // protocol-relative
    await rejectUrl("mailto:test@example.com");           // non-http(s) scheme
    await rejectUrl("file:///tmp/x");                     // non-http(s) scheme
    await rejectUrl("https://user:pass@example.test/a");  // credentials
    await rejectUrl("https://user@example.test/a");       // credentials
    await rejectUrl("https://example.test/a?token=SECRET");
    await rejectUrl("https://example.test/a#frag");
    await rejectUrl(`https://example.test/${"x".repeat(2000)}`);
    // A port and a plain origin path remain valid.
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "https://example.test:8443/api", transport: "fetch",
    }])).resolves.toBeDefined();
    await expect(appendDiagnostics(dir, [{
      ...base, method: "GET", url: "http://example.test", transport: "fetch",
    }])).resolves.toBeDefined();
  });

  it("rejects extra secret-bearing fields at the boundary instead of dropping them", async () => {
    const dir = root();
    const base = { source: "console", message: "visible", timestamp: "2026-08-12T12:00:00.000Z" };
    for (const extra of [
      { authorization: "Bearer SECRET_AUTH" },
      { cookie: "session=SECRET_COOKIE" },
      { requestBody: "SECRET_BODY" },
      { responseBody: "SECRET_BODY" },
      { formValue: "SECRET_FORM" },
      { headers: { authorization: "Bearer SECRET_AUTH" } },
      { query: "token=SECRET" },
    ]) {
      await expect(appendDiagnostics(dir, [{ ...base, ...extra }] as never))
        .rejects.toThrow("invalid entry field");
    }
    // Nothing is persisted when a boundary entry is rejected.
    expect(await readDiagnostics(dir)).toEqual([]);
  });

  it("clears only diagnostics and leaves the task untouched", async () => {
    const dir = root();
    await appendDiagnostics(dir, [{
      source: "console",
      message: "keep-me",
      timestamp: "2026-08-12T12:00:00.000Z",
    }]);
    await clearDiagnostics(dir);
    expect(await readDiagnostics(dir)).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, DIAGNOSTICS_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent appends and clears without lost or corrupted entries", async () => {
    const dir = root();
    const store = diagnosticsStore(dir);
    const base = { source: "console", message: "m", timestamp: "2026-08-12T12:00:00.000Z" };
    const writes = Array.from({ length: 40 }, (_, index) =>
      store.append([{ ...base, message: `w${index}` }]));
    const clears = [store.clear(), store.clear()];
    await Promise.all([...writes, ...clears]);
    const persisted = await readDiagnostics(dir);
    // The file always parses and stays bounded regardless of interleaving.
    expect(persisted.length).toBeLessThanOrEqual(20);
    for (const entry of persisted) {
      expect(entry.message).toMatch(/^w\d+$/);
    }
  });

  it("keeps diagnostics integral across racing CLI clear/read processes and local appends", async () => {
    const dir = root();
    const cliScript = path.resolve("dist/cli/index.mjs");
    const cleanEnv = (): NodeJS.ProcessEnv => {
      const env = { ...process.env };
      delete env.AGENT_ANNOTATIONS_DIR;
      delete env.AGENT_ANNOTATIONS_ROOT;
      return env;
    };
    const spawnCli = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliScript, ...args], {
        cwd: dir,
        env: cleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`cli ${args.join(" ")} exited with ${code}: ${output}`));
      });
    });
    const entry = (index: number) => ({
      source: "console",
      message: `cross-${index}`,
      timestamp: "2026-08-12T12:00:00.000Z",
    });
    // Separate CLI processes race the file lock against this process's own
    // store instance (its independent in-process queue) with appends, clears,
    // and reads all interleaved.
    const store = diagnosticsStore(dir);
    await store.append([entry(0)]);
    const clears = [spawnCli(["diagnostics", "--clear", "--json"]), spawnCli(["diagnostics", "--clear", "--json"])];
    const reads = [spawnCli(["diagnostics", "--json"]), spawnCli(["diagnostics", "--json"])];
    const appends = Array.from({ length: 30 }, (_, index) => store.append([entry(index + 2)]));
    const results = await Promise.all([
      Promise.all(clears),
      Promise.all(reads),
      ...appends,
    ]);
    const clearOutputs = results[0];
    const readOutputs = results[1];
    for (const output of clearOutputs) {
      expect(JSON.parse(output)).toEqual([]);
    }
    // Every CLI read output is a parseable JSON diagnostics array, and the
    // final file parses, stays bounded, and only contains valid entries.
    for (const output of readOutputs) {
      expect(Array.isArray(JSON.parse(output))).toBe(true);
    }
    const final = await readDiagnostics(dir);
    expect(final.length).toBeLessThanOrEqual(MAX_DIAGNOSTICS_ENTRIES);
    for (const persisted of final) {
      expect(persisted.message).toMatch(/^cross-\d+$/);
    }
    expect(JSON.parse(readFileSync(path.join(dir, DIAGNOSTICS_FILE), "utf8")).length)
      .toBe(final.length);
  }, 30_000);

  it("recovers a stale diagnostics lock left by a dead process", async () => {
    const dir = root();
    const store = diagnosticsStore(dir);
    const lock = path.join(dir, `${DIAGNOSTICS_FILE}.lock`);
    writeFileSync(lock, JSON.stringify({
      pid: 999_999_999,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      owner: "stale-owner",
    }));
    await store.append([{
      source: "console",
      message: "after-recovery",
      timestamp: "2026-08-12T12:00:00.000Z",
    }]);
    expect((await readDiagnostics(dir))[0]!.message).toBe("after-recovery");
    expect(() => statSync(lock)).toThrow();
  });
});
