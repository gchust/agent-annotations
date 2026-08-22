import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { AGENT_ANNOTATIONS_ID_PATTERN } from "../core/index.js";
import { atomicWriteJson } from "./store.js";

export const BROWSER_STATE_SCHEMA = "agent-annotations.browser-state.v2";
export const BROWSER_STATE_FILE = "browser-state.json";
// Fixed, documented staleness threshold: a heartbeat older than this never
// reports the browser as connected.
export const BROWSER_HEARTBEAT_STALE_MS = 15_000;

const MAX_ROUTE_KEY = 500;
const MAX_RUNTIME_ID = 64;
const MAX_CLIENT_VERSION = 128;
const MAX_REFERENCED_SOURCE_FILES = 256;
const MAX_SOURCE_FILE = 2_048;
const SHA256 = /^[0-9a-f]{64}$/;

export type AgentAnnotationsBrowserState = {
  schema: "agent-annotations.browser-state.v2";
  runtimeId: string;
  clientVersion: string;
  routeKey: string;
  taskId: string;
  taskRevision: number;
  browserUpdateRevision: number;
  referencedSourceRevision: string | null;
  referencedSourceFiles: string[];
  mountedAt: string;
  lastHeartbeatAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const boundedString = (value: unknown, maxLength: number, path: string): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return `${path} must be a non-empty string of at most ${maxLength} characters`;
  }
  return null;
};

const timestampIssue = (value: unknown, path: string): string | null => {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return `${path} must be an ISO-8601 timestamp`;
  }
  return null;
};

// Strict v2 parser: unknown fields are rejected, every string is bounded, and
// revisions/timestamps must be exact. The file never contains a token.
export const parseAgentAnnotationsBrowserState = (
  input: unknown
): AgentAnnotationsBrowserState => {
  if (!isRecord(input)) throw new TypeError("browser state must be an object");
  const known = new Set([
    "schema",
    "runtimeId",
    "clientVersion",
    "routeKey",
    "taskId",
    "taskRevision",
    "browserUpdateRevision",
    "referencedSourceRevision",
    "referencedSourceFiles",
    "mountedAt",
    "lastHeartbeatAt",
  ]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new TypeError(`unknown browser state field: ${key}`);
  }
  if (input.schema !== BROWSER_STATE_SCHEMA) {
    throw new TypeError(`unknown browser state schema: ${input.schema}`);
  }
  const runtimeId = boundedString(input.runtimeId, MAX_RUNTIME_ID, "runtimeId");
  if (runtimeId) throw new TypeError(runtimeId);
  const clientVersion = boundedString(input.clientVersion, MAX_CLIENT_VERSION, "clientVersion");
  if (clientVersion) throw new TypeError(clientVersion);
  const routeKey = boundedString(input.routeKey, MAX_ROUTE_KEY, "routeKey");
  if (routeKey) throw new TypeError(routeKey);
  // Privacy boundary: the route key must never carry a raw URL query; the
  // client strips query portions (keeping hash routes) and the server rejects
  // any route key that still contains one.
  if ((input.routeKey as string).includes("?")) {
    throw new TypeError("routeKey must not contain a query");
  }
  if (
    typeof input.taskId !== "string" ||
    !AGENT_ANNOTATIONS_ID_PATTERN.test(input.taskId)
  ) {
    throw new TypeError("taskId must be a valid task id");
  }
  if (
    typeof input.taskRevision !== "number" ||
    !Number.isInteger(input.taskRevision) ||
    input.taskRevision < 0
  ) {
    throw new TypeError("taskRevision must be a non-negative integer");
  }
  if (
    typeof input.browserUpdateRevision !== "number" ||
    !Number.isSafeInteger(input.browserUpdateRevision) ||
    input.browserUpdateRevision < 0
  ) {
    throw new TypeError("browserUpdateRevision must be a non-negative safe integer");
  }
  if (
    input.referencedSourceRevision !== null &&
    (typeof input.referencedSourceRevision !== "string" ||
      !SHA256.test(input.referencedSourceRevision))
  ) {
    throw new TypeError("referencedSourceRevision must be a 64-character hex sha256 or null");
  }
  if (
    !Array.isArray(input.referencedSourceFiles) ||
    input.referencedSourceFiles.length > MAX_REFERENCED_SOURCE_FILES
  ) {
    throw new TypeError(`referencedSourceFiles must contain at most ${MAX_REFERENCED_SOURCE_FILES} files`);
  }
  for (const file of input.referencedSourceFiles) {
    const issue = boundedString(file, MAX_SOURCE_FILE, "referencedSourceFiles entry");
    if (issue) throw new TypeError(issue);
  }
  const mountedAt = timestampIssue(input.mountedAt, "mountedAt");
  if (mountedAt) throw new TypeError(mountedAt);
  const lastHeartbeatAt = timestampIssue(input.lastHeartbeatAt, "lastHeartbeatAt");
  if (lastHeartbeatAt) throw new TypeError(lastHeartbeatAt);
  return input as AgentAnnotationsBrowserState;
};

export const browserStatePath = (runtimeRoot: string): string =>
  path.join(runtimeRoot, BROWSER_STATE_FILE);

export const readAgentAnnotationsBrowserState = (
  runtimeRoot: string
): AgentAnnotationsBrowserState | null => {
  let raw: string;
  try {
    raw = readFileSync(browserStatePath(runtimeRoot), "utf8");
  } catch {
    return null;
  }
  try {
    return parseAgentAnnotationsBrowserState(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const writeAgentAnnotationsBrowserState = (
  runtimeRoot: string,
  state: AgentAnnotationsBrowserState
): void => {
  atomicWriteJson(browserStatePath(runtimeRoot), state);
};

export const removeAgentAnnotationsBrowserState = (runtimeRoot: string): void => {
  rmSync(browserStatePath(runtimeRoot), { force: true });
};

export const isBrowserStateFresh = (state: AgentAnnotationsBrowserState, now = Date.now()): boolean => {
  // The heartbeat age must be at least zero (a future timestamp is invalid)
  // and at most the fixed staleness threshold.
  const age = now - Date.parse(state.lastHeartbeatAt);
  return age >= 0 && age <= BROWSER_HEARTBEAT_STALE_MS;
};
