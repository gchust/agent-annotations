import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_HEARTBEAT_STALE_MS,
  BROWSER_STATE_CLEANUP_MS,
  browserStatePath,
  isBrowserStateFresh,
  parseAgentAnnotationsBrowserState,
  readAgentAnnotationsBrowserStates,
  removeAgentAnnotationsBrowserState,
  selectAgentAnnotationsBrowserState,
  writeAgentAnnotationsBrowserState,
  type AgentAnnotationsBrowserState,
} from "../../src/server/browser-state.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "agent-annotations-browser-state-"));
  roots.push(value);
  return value;
};

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

const state: AgentAnnotationsBrowserState = {
  schema: "agent-annotations.browser-state.v2",
  runtimeId: "runtime-1",
  clientVersion: "0.1.0-alpha.0",
  routeKey: "/settings",
  taskId: "task-1",
  taskRevision: 3,
  browserUpdateRevision: 1,
  referencedSourceRevision: null,
  referencedSourceFiles: ["src/settings.tsx"],
  mountedAt: "2026-08-12T12:00:00.000Z",
  lastHeartbeatAt: "2026-08-12T12:00:05.000Z",
};

describe("browser state v2", () => {
  it("parses a valid state and rejects unknown fields", () => {
    expect(parseAgentAnnotationsBrowserState(state)).toEqual(state);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, token: "secret" }))
      .toThrow("unknown browser state field: token");
    expect(() => parseAgentAnnotationsBrowserState({ ...state, extra: true }))
      .toThrow("unknown browser state field: extra");
  });

  it("rejects wrong schemas, unbounded strings, bad revisions, and bad timestamps", () => {
    expect(() => parseAgentAnnotationsBrowserState({ ...state, schema: "agent-annotations.browser-state.v1" }))
      .toThrow(/unknown browser state schema/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, routeKey: "x".repeat(501) }))
      .toThrow(/routeKey/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, runtimeId: "" }))
      .toThrow(/runtimeId/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, taskId: "bad id!" }))
      .toThrow(/taskId/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, taskRevision: 1.5 }))
      .toThrow(/taskRevision/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, browserUpdateRevision: -1 }))
      .toThrow(/browserUpdateRevision/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, referencedSourceRevision: "short" }))
      .toThrow(/referencedSourceRevision/);
    expect(() => parseAgentAnnotationsBrowserState({
      ...state,
      referencedSourceFiles: Array.from({ length: 257 }, () => "src/a.ts"),
    })).toThrow(/referencedSourceFiles/);
    expect(() => parseAgentAnnotationsBrowserState({
      ...state,
      referencedSourceFiles: ["x".repeat(2_049)],
    })).toThrow(/referencedSourceFiles/);
    expect(() => parseAgentAnnotationsBrowserState({
      ...state,
      referencedSourceRevision: "ab".repeat(32),
      referencedSourceFiles: [],
    })).toThrow(/must be null/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, mountedAt: "not-a-date" }))
      .toThrow(/mountedAt/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, lastHeartbeatAt: "2026-13-99" }))
      .toThrow(/lastHeartbeatAt/);
  });

  it("rejects route keys that carry a query but preserves hash routes", () => {
    expect(() => parseAgentAnnotationsBrowserState({ ...state, routeKey: "/settings?token=abc" }))
      .toThrow(/routeKey/);
    expect(parseAgentAnnotationsBrowserState({ ...state, routeKey: "/#/settings" })).toMatchObject({
      routeKey: "/#/settings",
    });
    expect(parseAgentAnnotationsBrowserState({ ...state, routeKey: "/settings" })).toMatchObject({
      routeKey: "/settings",
    });
    expect(() => parseAgentAnnotationsBrowserState({ ...state, routeKey: "/settings\nadmin" }))
      .toThrow(/routeKey/);
  });

  it("writes parallel runtime states atomically with private mode", () => {
    const dir = root();
    writeAgentAnnotationsBrowserState(dir, state);
    writeAgentAnnotationsBrowserState(dir, { ...state, runtimeId: "runtime-2", routeKey: "/orders" });
    const file = browserStatePath(dir, state.runtimeId);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
    expect(readAgentAnnotationsBrowserStates(dir, Date.parse(state.lastHeartbeatAt)).map(({ runtimeId, routeKey }) => ({ runtimeId, routeKey })))
      .toEqual([
        { runtimeId: "runtime-1", routeKey: "/settings" },
        { runtimeId: "runtime-2", routeKey: "/orders" },
      ]);
    removeAgentAnnotationsBrowserState(dir, "runtime-1");
    expect(readAgentAnnotationsBrowserStates(dir, Date.parse(state.lastHeartbeatAt)).map(({ runtimeId }) => runtimeId)).toEqual(["runtime-2"]);
  });

  it("cleans invalid and expired files without deleting merely stale states", () => {
    const dir = root();
    const states = path.join(dir, "browser-states");
    mkdirSync(states, { recursive: true });
    writeFileSync(path.join(states, "invalid.json"), "{broken");
    writeAgentAnnotationsBrowserState(dir, state);
    const now = Date.parse(state.lastHeartbeatAt);
    expect(readAgentAnnotationsBrowserStates(dir, now + BROWSER_HEARTBEAT_STALE_MS + 1)).toEqual([state]);
    expect(readAgentAnnotationsBrowserStates(dir, now + BROWSER_STATE_CLEANUP_MS + 1)).toEqual([]);
    expect(readAgentAnnotationsBrowserStates(dir)).toEqual([]);
    expect(isBrowserStateFresh(state, now)).toBe(true);
    expect(isBrowserStateFresh(state, now + BROWSER_HEARTBEAT_STALE_MS + 1)).toBe(false);
    // A future heartbeat timestamp is invalid, never fresh.
    expect(isBrowserStateFresh(state, now - 1)).toBe(false);
    expect(isBrowserStateFresh({
      ...state,
      lastHeartbeatAt: new Date(Date.now() + 60_000).toISOString(),
    })).toBe(false);
  });

  it("selects one fresh runtime deterministically and reports ambiguity or missing selectors", () => {
    const now = Date.parse(state.lastHeartbeatAt);
    const other = { ...state, runtimeId: "runtime-2", routeKey: "/orders" };
    expect(selectAgentAnnotationsBrowserState([state], {}, now)).toEqual({ selected: state, error: null });
    expect(selectAgentAnnotationsBrowserState([state, other], {}, now)).toEqual({
      selected: null,
      error: "ambiguous_browser_runtime",
    });
    expect(selectAgentAnnotationsBrowserState([state, other], { runtimeId: "runtime-2" }, now))
      .toEqual({ selected: other, error: null });
    expect(selectAgentAnnotationsBrowserState([state, other], { routeKey: "/settings" }, now))
      .toEqual({ selected: state, error: null });
    expect(selectAgentAnnotationsBrowserState([state], { runtimeId: "missing" }, now)).toEqual({
      selected: null,
      error: "browser_runtime_not_found",
    });
  });

  it("rejects runtime ids that could escape browser-states", () => {
    for (const runtimeId of ["../escape", "a/b", "a\\b", ".", "", "x".repeat(65)]) {
      expect(() => browserStatePath(root(), runtimeId)).toThrow(/runtimeId/);
    }
    expect(() => parseAgentAnnotationsBrowserState({ ...state, runtimeId: "../escape" }))
      .toThrow(/runtimeId/);
  });
});
