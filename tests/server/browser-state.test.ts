import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_HEARTBEAT_STALE_MS,
  isBrowserStateFresh,
  parseAgentAnnotationsBrowserState,
  readAgentAnnotationsBrowserState,
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
  schema: "agent-annotations.browser-state.v1",
  runtimeId: "runtime-1",
  clientVersion: "0.1.0-alpha.0",
  routeKey: "/settings",
  taskId: "task-1",
  taskRevision: 3,
  appliedSourceRevision: null,
  mountedAt: "2026-08-12T12:00:00.000Z",
  lastHeartbeatAt: "2026-08-12T12:00:05.000Z",
};

describe("browser state v1", () => {
  it("parses a valid state and rejects unknown fields", () => {
    expect(parseAgentAnnotationsBrowserState(state)).toEqual(state);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, token: "secret" }))
      .toThrow("unknown browser state field: token");
    expect(() => parseAgentAnnotationsBrowserState({ ...state, extra: true }))
      .toThrow("unknown browser state field: extra");
  });

  it("rejects wrong schemas, unbounded strings, bad revisions, and bad timestamps", () => {
    expect(() => parseAgentAnnotationsBrowserState({ ...state, schema: "other.v1" }))
      .toThrow(/unknown browser state schema/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, routeKey: "x".repeat(501) }))
      .toThrow(/routeKey/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, runtimeId: "" }))
      .toThrow(/runtimeId/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, taskId: "bad id!" }))
      .toThrow(/taskId/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, taskRevision: 1.5 }))
      .toThrow(/taskRevision/);
    expect(() => parseAgentAnnotationsBrowserState({ ...state, appliedSourceRevision: "short" }))
      .toThrow(/appliedSourceRevision/);
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
  });

  it("writes atomically with session-level mode and reads back", () => {
    const dir = root();
    writeAgentAnnotationsBrowserState(dir, state);
    const file = path.join(dir, "browser-state.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
    expect(readAgentAnnotationsBrowserState(dir)).toEqual(state);
  });

  it("treats unreadable or invalid files as absent and marks stale heartbeats", () => {
    const dir = root();
    expect(readAgentAnnotationsBrowserState(dir)).toBeNull();
    writeFileSync(path.join(dir, "browser-state.json"), "{broken");
    expect(readAgentAnnotationsBrowserState(dir)).toBeNull();
    const now = Date.parse(state.lastHeartbeatAt);
    expect(isBrowserStateFresh(state, now)).toBe(true);
    expect(isBrowserStateFresh(state, now + BROWSER_HEARTBEAT_STALE_MS + 1)).toBe(false);
    // A future heartbeat timestamp is invalid, never fresh.
    expect(isBrowserStateFresh(state, now - 1)).toBe(false);
    expect(isBrowserStateFresh({
      ...state,
      lastHeartbeatAt: new Date(Date.now() + 60_000).toISOString(),
    })).toBe(false);
  });
});
