import { lstatSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

import type { AgentAnnotationsTask } from "../types/index.js";

export const EVIDENCE_DIR = "evidence";

export type EvidenceEntry = {
  ref: string;
  size: number;
  annotationIds: string[];
};

const resolveEvidenceFile = (root: string, ref: string): string | null => {
  if (typeof ref !== "string") return null;
  const segments = ref.split("/");
  if (segments[0] !== EVIDENCE_DIR || segments.length < 2) return null;
  for (const segment of segments.slice(1)) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
      return null;
    }
  }
  const evidenceRoot = path.join(root, EVIDENCE_DIR);
  const absolute = path.resolve(root, ...segments);
  if (absolute !== evidenceRoot && !absolute.startsWith(`${evidenceRoot}${path.sep}`)) {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return null;
  }
  if (real !== absolute) return null;
  try {
    if (!statSync(absolute).isFile()) return null;
  } catch {
    return null;
  }
  return absolute;
};

export const listEvidence = (root: string, task: AgentAnnotationsTask): EvidenceEntry[] => {
  const byFile = new Map<string, EvidenceEntry>();
  for (const annotation of task.annotations) {
    for (const evidence of annotation.evidence ?? []) {
      const absolute = resolveEvidenceFile(root, evidence.ref);
      if (!absolute) continue;
      const existing = byFile.get(absolute);
      if (existing) {
        existing.annotationIds.push(annotation.annotationId);
      } else {
        byFile.set(absolute, {
          ref: evidence.ref,
          size: statSync(absolute).size,
          annotationIds: [annotation.annotationId],
        });
      }
    }
  }
  return [...byFile.values()].sort((left, right) => left.ref.localeCompare(right.ref));
};

export const collectEvidenceRefs = (task: AgentAnnotationsTask): Set<string> => {
  const refs = new Set<string>();
  for (const annotation of task.annotations) {
    for (const evidence of annotation.evidence ?? []) {
      refs.add(evidence.ref);
    }
  }
  return refs;
};

export const removeEvidenceRefs = (root: string, refs: readonly string[]): string[] => {
  const removed: string[] = [];
  for (const ref of refs) {
    const absolute = resolveEvidenceFile(root, ref);
    if (!absolute) continue;
    try {
      rmSync(absolute, { force: true });
      removed.push(ref);
    } catch {
      // Best-effort cleanup never fails the already-persisted mutation.
    }
  }
  return removed;
};

// Recently written evidence may still be awaiting the task mutation that
// references it (writeEvidence writes the file, then persists the task).
// A prune must never delete such a file, so a grace window applies.
export const EVIDENCE_GRACE_PERIOD_MS = 60_000;

export type EvidencePruneResult = {
  deleted: string[];
  skipped: string[];
  errors: string[];
};

// Orphan sweep: only regular files directly inside <runtimeRoot>/evidence are
// considered; symlinks, directories, and nested paths are never followed or
// deleted, and anything referenced by the current valid task is preserved.
export const pruneOrphanEvidence = (
  root: string,
  task: AgentAnnotationsTask,
  graceMs: number = EVIDENCE_GRACE_PERIOD_MS
): EvidencePruneResult => {
  const deleted: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const referenced = collectEvidenceRefs(task);
  const evidenceRoot = path.join(root, EVIDENCE_DIR);
  let entries: Dirent<string>[] | null = null;
  try {
    // The evidence root itself must be a real directory: a symlinked root
    // would redirect the whole sweep outside the runtime directory.
    const rootStat = lstatSync(evidenceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { deleted, skipped, errors };
    }
    entries = readdirSync(evidenceRoot, { encoding: "utf8", withFileTypes: true }) as Dirent<string>[];
  } catch {
    // Missing or unreadable evidence directory: nothing to prune.
    return { deleted, skipped, errors };
  }
  // Stable output: process entries in name order regardless of readdir order.
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const now = Date.now();
  for (const entry of entries) {
    // Directories and symlinks are never deleted ("don't follow symlinks").
    if (!entry.isFile()) {
      skipped.push(`${EVIDENCE_DIR}/${entry.name}`);
      continue;
    }
    const ref = `${EVIDENCE_DIR}/${entry.name}`;
    if (referenced.has(ref)) continue;
    const absolute = path.join(evidenceRoot, entry.name);
    // lstat, never stat: a symlink swapped in between the directory read and
    // this check must not be followed or deleted.
    let entryStat;
    try {
      entryStat = lstatSync(absolute);
    } catch {
      errors.push(ref);
      continue;
    }
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
      skipped.push(ref);
      continue;
    }
    if (entryStat.mtimeMs > now - graceMs) {
      skipped.push(ref);
      continue;
    }
    try {
      rmSync(absolute, { force: true });
      deleted.push(ref);
    } catch {
      errors.push(ref);
    }
  }
  return { deleted, skipped, errors };
};
