import { realpathSync, rmSync, statSync } from "node:fs";
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
