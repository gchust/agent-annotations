import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentAnnotation,
  AgentAnnotationsSourceLocation,
  AgentAnnotationsTask,
} from "../types/index.js";

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const stripSuffix = (value: string): string => value.split(/[?#]/, 1)[0]!;

export const createSourcePathService = (workspaceRoot: string) => {
  const resolvedRoot = path.resolve(workspaceRoot);
  const root = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;

  const canonicalize = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes("\0")) return null;
    let value: string;
    try {
      value = trimmed.startsWith("file:")
        ? fileURLToPath(stripSuffix(trimmed))
        : decodeURIComponent(stripSuffix(trimmed));
    } catch {
      return null;
    }
    if (value.startsWith("/@fs/")) value = value.slice(5);
    value = value.replace(/\\/g, "/");
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) && !WINDOWS_ABSOLUTE.test(value)) {
      return null;
    }

    let candidate: string;
    if (WINDOWS_ABSOLUTE.test(value)) {
      const rootWindows = root.replace(/\\/g, "/");
      if (!WINDOWS_ABSOLUTE.test(rootWindows)) {
        const tail = value.slice(2);
        if (tail !== rootWindows && !tail.startsWith(`${rootWindows}/`)) return null;
        candidate = tail;
      } else {
        candidate = value.toLowerCase().startsWith(rootWindows.toLowerCase())
          ? path.resolve(root, value.slice(rootWindows.length).replace(/^\/+/, ""))
          : value;
      }
    } else {
      candidate = value === "/src" || value.startsWith("/src/")
        ? path.resolve(root, value.slice(1))
        : path.isAbsolute(value)
          ? path.resolve(value)
          : path.resolve(root, value);
    }
    if (!inside(root, candidate) || !existsSync(candidate)) return null;

    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return null;
    }
    return inside(root, real) && statSync(real).isFile()
      ? path.relative(root, real).split(path.sep).join("/") || null
      : null;
  };

  const files = (task: AgentAnnotationsTask): string[] => {
    const paths = new Set<string>();
    for (const annotation of task.annotations) {
      for (const target of annotation.targets ?? []) {
        for (const source of [target.inspection.source, ...target.inspection.sourceStack]) {
          if (source?.filePath) paths.add(source.filePath);
        }
      }
    }
    return [...paths].flatMap((file) => canonicalize(file) ?? []).sort();
  };

  const revision = (task: AgentAnnotationsTask): string | null => {
    const referencedSourceFiles = files(task);
    if (referencedSourceFiles.length === 0) return null;
    const hash = createHash("sha256");
    for (const canonical of referencedSourceFiles) {
      hash.update(canonical);
      hash.update("\0");
      hash.update(readFileSync(path.join(root, canonical)));
      hash.update("\0");
    }
    return hash.digest("hex");
  };

  const canonicalizeAnnotation = (annotation: AgentAnnotation): AgentAnnotation => {
    const frame = (source: AgentAnnotationsSourceLocation): AgentAnnotationsSourceLocation | null => {
      const filePath = canonicalize(source.filePath);
      return filePath ? { ...source, filePath } : null;
    };
    return {
      ...annotation,
      targets: annotation.targets?.map((target) => ({
        ...target,
        inspection: {
          ...target.inspection,
          source: target.inspection.source ? frame(target.inspection.source) : null,
          sourceStack: target.inspection.sourceStack.flatMap((source) => frame(source) ?? []),
        },
      })),
    };
  };

  return { canonicalize, canonicalizeAnnotation, files, revision };
};
