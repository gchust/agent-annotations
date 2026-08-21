import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { redactAgentAnnotationsText } from "../core/index.js";
import { atomicWriteJson } from "./store.js";
import type { AgentAnnotationsDiagnosticsEntry } from "../types/index.js";

export const DIAGNOSTICS_FILE = "diagnostics.json";
export const MAX_DIAGNOSTICS_ENTRIES = 20;
export const MAX_DIAGNOSTICS_MESSAGE_LENGTH = 500;
export const MAX_DIAGNOSTICS_BYTES = 64 * 1024;

const SOURCES = new Set(["console", "window", "promise", "extension"]);
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

const entryIssue = (entry: unknown): string | null => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "invalid entry";
  }
  const { source, message, timestamp, extensionId, contributionId, phase } =
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
});

export const readDiagnostics = (root: string): AgentAnnotationsDiagnosticsEntry[] => {
  const file = path.join(root, DIAGNOSTICS_FILE);
  let parsed: unknown;
  try {
    if (statSync(file).size > MAX_DIAGNOSTICS_BYTES) return [];
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is AgentAnnotationsDiagnosticsEntry => entryIssue(entry) === null)
    .map(sanitizeEntry)
    .slice(-MAX_DIAGNOSTICS_ENTRIES);
};

export const appendDiagnostics = (
  root: string,
  input: unknown
): AgentAnnotationsDiagnosticsEntry[] => {
  if (!Array.isArray(input)) throw new TypeError("diagnostics entries must be an array");
  if (input.length > MAX_DIAGNOSTICS_ENTRIES) {
    throw new TypeError("too many diagnostics entries");
  }
  const entries = input.map((entry) => {
    const issue = entryIssue(entry);
    if (issue) throw new TypeError(`invalid diagnostics entry: ${issue}`);
    return sanitizeEntry(entry as AgentAnnotationsDiagnosticsEntry);
  });
  const next = [...readDiagnostics(root), ...entries].slice(-MAX_DIAGNOSTICS_ENTRIES);
  atomicWriteJson(path.join(root, DIAGNOSTICS_FILE), next);
  return next;
};

export const clearDiagnostics = (root: string): void => {
  atomicWriteJson(path.join(root, DIAGNOSTICS_FILE), []);
};
