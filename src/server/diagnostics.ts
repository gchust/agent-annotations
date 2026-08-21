import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { redactAgentAnnotationsText } from "../core/index.js";
import { acquireFileLock, LOCK_ACQUIRE_TIMEOUT_MS } from "./file-lock.js";
import { atomicWriteJson } from "./store.js";
import type { AgentAnnotationsDiagnosticsEntry } from "../types/index.js";

export const DIAGNOSTICS_FILE = "diagnostics.json";
export const MAX_DIAGNOSTICS_ENTRIES = 20;
export const MAX_DIAGNOSTICS_MESSAGE_LENGTH = 500;
export const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
export const MAX_NETWORK_URL_LENGTH = 2000;

const SOURCES = new Set(["console", "window", "promise", "network", "extension"]);
const PHASES = new Set([
  "setup",
  "visible",
  "enabled",
  "pressed",
  "icon",
  "panel",
  "execute",
  "enrich",
  "export",
  "redact",
  "dispose",
]);
const MAX_EXTENSION_ID = 64;
const MAX_CONTRIBUTION_ID = 256;
const MAX_METHOD = 16;

// Strict field allowlist: unknown keys (e.g. authorization, cookie, request
// body/header/form values) are rejected rather than silently dropped, so a
// secret-bearing payload can never slip through the boundary.
const ALLOWED_ENTRY_FIELDS = new Set([
  "source",
  "message",
  "timestamp",
  "extensionId",
  "contributionId",
  "phase",
  "method",
  "url",
  "status",
  "transport",
]);

const entryIssue = (entry: unknown): string | null => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "invalid entry";
  }
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_ENTRY_FIELDS.has(key)) return "invalid entry field";
  }
  const { source, message, timestamp, extensionId, contributionId, phase, method, url, status, transport } =
    entry as Record<string, unknown>;
  if (typeof source !== "string" || !SOURCES.has(source)) return "invalid source";
  if (typeof message !== "string") return "invalid message";
  if (
    typeof timestamp !== "string" ||
    Number.isNaN(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    return "invalid timestamp";
  }
  if (source === "extension") {
    // Extension entries must locate the failing extension and phase.
    if (
      typeof extensionId !== "string" ||
      extensionId.length === 0 ||
      extensionId.length > MAX_EXTENSION_ID
    ) {
      return "invalid extensionId";
    }
    if (typeof phase !== "string" || !PHASES.has(phase)) {
      return "invalid phase";
    }
    if (
      contributionId !== undefined &&
      (typeof contributionId !== "string" ||
        contributionId.length === 0 ||
        contributionId.length > MAX_CONTRIBUTION_ID)
    ) {
      return "invalid contributionId";
    }
  } else if (
    extensionId !== undefined ||
    contributionId !== undefined ||
    phase !== undefined
  ) {
    return "invalid extension fields";
  }
  if (source === "network") {
    // Network entries carry strict, privacy-safe metadata: uppercase method,
    // origin+path only URL (no query/fragment), optional status, transport.
    if (
      typeof method !== "string" ||
      method.length === 0 ||
      method.length > MAX_METHOD ||
      !/^[A-Z]+$/.test(method)
    ) {
      return "invalid method";
    }
    // The URL must be a real, sanitized http(s) origin+path: it parses as an
    // absolute URL, has a host, drops to origin+pathname with no credentials,
    // query, or fragment, and must not be a bare relative path.
    if (typeof url !== "string" || url.length === 0 || url.length > MAX_NETWORK_URL_LENGTH) {
      return "invalid url";
    }
    if (url.includes("?") || url.includes("#")) {
      return "invalid url";
    }
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      return "invalid url";
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname === "" ||
      `${parsed.origin}${parsed.pathname}` !== parsed.href
    ) {
      return "invalid url";
    }
    if (status !== undefined) {
      if (
        typeof status !== "number" ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599
      ) {
        return "invalid status";
      }
    }
    if (transport !== "fetch" && transport !== "xhr") {
      return "invalid transport";
    }
  } else if (
    method !== undefined ||
    url !== undefined ||
    status !== undefined ||
    transport !== undefined
  ) {
    return "invalid network fields";
  }
  return null;
};

const sanitizeEntry = (
  entry: AgentAnnotationsDiagnosticsEntry
): AgentAnnotationsDiagnosticsEntry => ({
  source: entry.source,
  message: redactAgentAnnotationsText(entry.message, {
    maxLength: MAX_DIAGNOSTICS_MESSAGE_LENGTH,
  }),
  timestamp: entry.timestamp,
  ...(entry.extensionId !== undefined ? { extensionId: entry.extensionId } : {}),
  ...(entry.contributionId !== undefined ? { contributionId: entry.contributionId } : {}),
  ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
  ...(entry.method !== undefined ? { method: entry.method } : {}),
  ...(entry.url !== undefined ? { url: entry.url } : {}),
  ...(entry.status !== undefined ? { status: entry.status } : {}),
  ...(entry.transport !== undefined ? { transport: entry.transport } : {}),
});

// Serialized, cross-process-safe diagnostics persistence: every operation is
// queued in-process and guarded by the shared file lock (same stale-lock
// recovery as task writes), so browser appends and CLI clears never lose or
// corrupt entries. All operations are async and consistent at every caller.
export class DiagnosticsStore {
  readonly root: string;
  readonly file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, DIAGNOSTICS_FILE);
  }

  #lockPath(): string {
    return `${this.file}.lock`;
  }

  #locked<T>(operation: () => T): Promise<T> {
    const result = this.#queue.then(async () => {
      const unlock = await acquireFileLock(this.#lockPath(), LOCK_ACQUIRE_TIMEOUT_MS);
      try {
        return operation();
      } finally {
        unlock();
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #readUnlocked(): AgentAnnotationsDiagnosticsEntry[] {
    let parsed: unknown;
    try {
      if (statSync(this.file).size > MAX_DIAGNOSTICS_BYTES) return [];
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is AgentAnnotationsDiagnosticsEntry => entryIssue(entry) === null)
      .map(sanitizeEntry)
      .slice(-MAX_DIAGNOSTICS_ENTRIES);
  }

  async read(): Promise<AgentAnnotationsDiagnosticsEntry[]> {
    return this.#locked(() => this.#readUnlocked());
  }

  async append(input: unknown): Promise<AgentAnnotationsDiagnosticsEntry[]> {
    if (!Array.isArray(input)) throw new TypeError("diagnostics entries must be an array");
    if (input.length > MAX_DIAGNOSTICS_ENTRIES) {
      throw new TypeError("too many diagnostics entries");
    }
    const entries = input.map((entry) => {
      const issue = entryIssue(entry);
      if (issue) throw new TypeError(`invalid diagnostics entry: ${issue}`);
      return sanitizeEntry(entry as AgentAnnotationsDiagnosticsEntry);
    });
    return this.#locked(() => {
      const next = [...this.#readUnlocked(), ...entries].slice(-MAX_DIAGNOSTICS_ENTRIES);
      atomicWriteJson(this.file, next);
      return next;
    });
  }

  async clear(): Promise<void> {
    return this.#locked(() => {
      atomicWriteJson(this.file, []);
    });
  }
}

const stores = new Map<string, DiagnosticsStore>();

export const diagnosticsStore = (root: string): DiagnosticsStore => {
  const resolved = path.resolve(root);
  let store = stores.get(resolved);
  if (!store) {
    store = new DiagnosticsStore(resolved);
    stores.set(resolved, store);
  }
  return store;
};

export const readDiagnostics = async (root: string): Promise<AgentAnnotationsDiagnosticsEntry[]> =>
  diagnosticsStore(root).read();

export const appendDiagnostics = async (
  root: string,
  input: unknown
): Promise<AgentAnnotationsDiagnosticsEntry[]> => diagnosticsStore(root).append(input);

export const clearDiagnostics = async (root: string): Promise<void> =>
  diagnosticsStore(root).clear();
