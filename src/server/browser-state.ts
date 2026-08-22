import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Dirent,
} from "node:fs";
import path from "node:path";

import { AGENT_ANNOTATIONS_ID_PATTERN } from "../core/index.js";
import { atomicWriteJson } from "./store.js";

export const BROWSER_STATE_SCHEMA = "agent-annotations.browser-state.v2";
export const BROWSER_STATES_DIR = "browser-states";
// A heartbeat older than this never reports the browser as connected.
export const BROWSER_HEARTBEAT_STALE_MS = 15_000;
// Stale files remain visible for diagnostics, then are removed after one day.
export const BROWSER_STATE_CLEANUP_MS = 24 * 60 * 60 * 1_000;

const MAX_ROUTE_KEY = 500;
const MAX_CLIENT_VERSION = 128;
const MAX_REFERENCED_SOURCE_FILES = 256;
const MAX_SOURCE_FILE = 2_048;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

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

export type AgentAnnotationsBrowserStateSelector = {
  runtimeId?: string;
  routeKey?: string;
};

export type AgentAnnotationsBrowserStateSelection = {
  selected: AgentAnnotationsBrowserState | null;
  error: "ambiguous_browser_runtime" | "browser_runtime_not_found" | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const boundedString = (value: unknown, maxLength: number, field: string): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return `${field} must be a non-empty string of at most ${maxLength} characters`;
  }
  return null;
};

const timestampIssue = (value: unknown, field: string): string | null => {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return `${field} must be an ISO-8601 timestamp`;
  }
  return null;
};

export const parseAgentAnnotationsRuntimeId = (value: unknown): string => {
  if (typeof value !== "string" || !AGENT_ANNOTATIONS_ID_PATTERN.test(value)) {
    throw new TypeError("runtimeId must be a valid runtime id");
  }
  return value;
};

export const parseAgentAnnotationsRouteKey = (value: unknown): string => {
  const issue = boundedString(value, MAX_ROUTE_KEY, "routeKey");
  if (issue) throw new TypeError(issue);
  if ((value as string).includes("?") || CONTROL.test(value as string)) {
    throw new TypeError("routeKey must not contain a query or control characters");
  }
  return value as string;
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
  parseAgentAnnotationsRuntimeId(input.runtimeId);
  const clientVersion = boundedString(input.clientVersion, MAX_CLIENT_VERSION, "clientVersion");
  if (clientVersion) throw new TypeError(clientVersion);
  parseAgentAnnotationsRouteKey(input.routeKey);
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
  if (input.referencedSourceFiles.length === 0 && input.referencedSourceRevision !== null) {
    throw new TypeError("referencedSourceRevision must be null when referencedSourceFiles is empty");
  }
  const mountedAt = timestampIssue(input.mountedAt, "mountedAt");
  if (mountedAt) throw new TypeError(mountedAt);
  const lastHeartbeatAt = timestampIssue(input.lastHeartbeatAt, "lastHeartbeatAt");
  if (lastHeartbeatAt) throw new TypeError(lastHeartbeatAt);
  return input as AgentAnnotationsBrowserState;
};

const statesRoot = (runtimeRoot: string): string =>
  path.resolve(runtimeRoot, BROWSER_STATES_DIR);

const checkedStatesRoot = (runtimeRoot: string, create: boolean): string | null => {
  const runtime = path.resolve(runtimeRoot);
  const root = statesRoot(runtime);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch {
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("browser-states must be a real directory");
  }
  const relative = path.relative(realpathSync(runtime), realpathSync(root));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("browser-states escapes runtime root");
  }
  return root;
};

export const browserStatePath = (runtimeRoot: string, runtimeId: string): string => {
  const id = parseAgentAnnotationsRuntimeId(runtimeId);
  const root = statesRoot(runtimeRoot);
  const file = path.resolve(root, `${id}.json`);
  if (path.dirname(file) !== root) throw new TypeError("runtimeId escapes browser-states");
  return file;
};

export const readAgentAnnotationsBrowserStates = (
  runtimeRoot: string,
  now = Date.now()
): AgentAnnotationsBrowserState[] => {
  let root: string;
  try {
    root = checkedStatesRoot(runtimeRoot, false) ?? statesRoot(runtimeRoot);
  } catch {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const states: AgentAnnotationsBrowserState[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const runtimeId = entry.name.slice(0, -".json".length);
    let file: string;
    try {
      file = browserStatePath(runtimeRoot, runtimeId);
      const state = parseAgentAnnotationsBrowserState(JSON.parse(readFileSync(file, "utf8")));
      if (state.runtimeId !== runtimeId) throw new TypeError("runtimeId does not match filename");
      if (now - Date.parse(state.lastHeartbeatAt) > BROWSER_STATE_CLEANUP_MS) {
        rmSync(file, { force: true });
      } else {
        states.push(state);
      }
    } catch {
      try {
        file = path.resolve(root, entry.name);
        if (path.dirname(file) === root) rmSync(file, { force: true });
      } catch {
        // Invalid state is absent even if cleanup fails.
      }
    }
  }
  return states.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
};

export const writeAgentAnnotationsBrowserState = (
  runtimeRoot: string,
  input: AgentAnnotationsBrowserState
): void => {
  const state = parseAgentAnnotationsBrowserState(input);
  checkedStatesRoot(runtimeRoot, true);
  atomicWriteJson(browserStatePath(runtimeRoot, state.runtimeId), state);
};

export const removeAgentAnnotationsBrowserState = (
  runtimeRoot: string,
  runtimeId: string
): void => {
  const root = checkedStatesRoot(runtimeRoot, false);
  if (root === null) return;
  rmSync(browserStatePath(runtimeRoot, runtimeId), { force: true });
};

export const isBrowserStateFresh = (state: AgentAnnotationsBrowserState, now = Date.now()): boolean => {
  const age = now - Date.parse(state.lastHeartbeatAt);
  return age >= 0 && age <= BROWSER_HEARTBEAT_STALE_MS;
};

export const selectAgentAnnotationsBrowserState = (
  states: readonly AgentAnnotationsBrowserState[],
  selector: AgentAnnotationsBrowserStateSelector = {},
  now = Date.now()
): AgentAnnotationsBrowserStateSelection => {
  const fresh = states.filter((state) => isBrowserStateFresh(state, now));
  const matches = selector.runtimeId !== undefined
    ? fresh.filter((state) => state.runtimeId === selector.runtimeId)
    : selector.routeKey !== undefined
      ? fresh.filter((state) => state.routeKey === selector.routeKey)
      : fresh;
  if (matches.length === 1) return { selected: matches[0]!, error: null };
  if (matches.length > 1) return { selected: null, error: "ambiguous_browser_runtime" };
  return {
    selected: null,
    error: selector.runtimeId !== undefined || selector.routeKey !== undefined
      ? "browser_runtime_not_found"
      : null,
  };
};
