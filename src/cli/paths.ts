import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { AgentAnnotationsSession } from "../server/store.js";

export type CliPathOptions = {
  cwd: string;
  root: string | null;
  dir: string | null;
  env: NodeJS.ProcessEnv;
};

export type CliPathResolution =
  | { ok: true; workspaceRoot: string; runtimeRoot: string; session: AgentAnnotationsSession | null }
  | { ok: false; message: string; code: number };

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Absolute, symlink-resolved canonical path. Non-existent paths stay resolved;
// callers that received an explicit path report them as stable errors.
export const canonicalPath = (value: string): string => {
  const absolute = path.resolve(value);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
};

const readSession = (file: string): AgentAnnotationsSession | null => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = parsed as Partial<AgentAnnotationsSession>;
  if (
    typeof candidate.endpoint !== "string" ||
    typeof candidate.origin !== "string" ||
    typeof candidate.pid !== "number" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.token !== "string" ||
    typeof candidate.workspaceRoot !== "string" ||
    typeof candidate.runtimeRoot !== "string"
  ) {
    return null;
  }
  // The recorded roots must still exist and be canonicalized before use.
  if (!existsSync(candidate.workspaceRoot) || !existsSync(candidate.runtimeRoot)) {
    return null;
  }
  return {
    endpoint: candidate.endpoint,
    origin: candidate.origin,
    pid: candidate.pid,
    startedAt: candidate.startedAt,
    token: candidate.token,
    workspaceRoot: canonicalPath(candidate.workspaceRoot),
    runtimeRoot: canonicalPath(candidate.runtimeRoot),
  };
};

const isRegularDirectory = (directory: string): boolean => {
  try {
    return lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
};

// Nearest ancestor (starting at `start`) holding a real (non-symlinked)
// `.agent-annotations/session.json`. The walk never crosses the filesystem
// root and never follows untrusted symlinks: the start is canonicalized and
// every `.agent-annotations` candidate must be a genuine directory.
const findNearestSession = (start: string): AgentAnnotationsSession | null => {
  let current = canonicalPath(start);
  while (true) {
    const runtime = path.join(current, ".agent-annotations");
    if (isRegularDirectory(runtime)) {
      const session = readSession(path.join(runtime, "session.json"));
      if (session) return session;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

// A recognizable project root: `package.json` or `.git`, checked without
// following symlinks.
const isWorkspaceMarker = (directory: string): boolean => {
  for (const name of ["package.json", ".git"]) {
    try {
      const stat = lstatSync(path.join(directory, name));
      if (stat.isFile() || stat.isDirectory()) return true;
    } catch {
      // No such marker at this level; keep walking.
    }
  }
  return false;
};

const findNearestWorkspace = (start: string): string | null => {
  let current = canonicalPath(start);
  while (true) {
    if (isWorkspaceMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

// Single resolution entry point used by every CLI command:
//
// Session discovery: 1. --dir, 2. AGENT_ANNOTATIONS_DIR, 3. nearest ancestor
//   `.agent-annotations/session.json` (the Vite plugin writes the session at
//   the resolved workspace's `.agent-annotations`).
// Workspace root:   1. --root, 2. AGENT_ANNOTATIONS_ROOT, 3. validated session
//     workspaceRoot, 4. nearest ancestor workspace (package.json/.git), 5. cwd.
// Runtime root:     1. --dir, 2. AGENT_ANNOTATIONS_DIR, 3. validated session
//     runtimeRoot, 4. <workspaceRoot>/.agent-annotations.
// Unless the runtime root is user-provided (--dir/AGENT_ANNOTATIONS_DIR), a
// session runtime root outside the resolved workspace root is rejected.
export const resolveCliPaths = (options: CliPathOptions): CliPathResolution => {
  const cwd = canonicalPath(options.cwd);
  const envRoot = options.env.AGENT_ANNOTATIONS_ROOT || null;
  const envDir = options.env.AGENT_ANNOTATIONS_DIR || null;
  const userRuntime = options.dir ?? envDir;

  // 1. Session discovery.
  let session: AgentAnnotationsSession | null = null;
  if (userRuntime) {
    const required = requiredPath(userRuntime, "runtime root");
    if (!required.ok) return { ok: false, message: required.message, code: 2 };
    session = readSession(path.join(required.value, "session.json"));
  } else {
    session = findNearestSession(cwd);
  }

  // 2. Workspace root.
  let workspaceRoot: string;
  if (options.root || envRoot) {
    const required = requiredPath(options.root ?? envRoot!, "workspace root");
    if (!required.ok) return { ok: false, message: required.message, code: 2 };
    workspaceRoot = required.value;
  } else {
    workspaceRoot = session?.workspaceRoot ?? findNearestWorkspace(cwd) ?? cwd;
  }

  // 3. Runtime root.
  let runtimeRoot: string;
  if (options.dir) {
    const required = requiredPath(options.dir, "runtime root");
    if (!required.ok) return { ok: false, message: required.message, code: 2 };
    runtimeRoot = required.value;
  } else if (envDir) {
    const required = requiredPath(envDir, "runtime root");
    if (!required.ok) return { ok: false, message: required.message, code: 2 };
    runtimeRoot = required.value;
  } else if (session && inside(workspaceRoot, session.runtimeRoot)) {
    runtimeRoot = session.runtimeRoot;
  } else {
    runtimeRoot = path.join(workspaceRoot, ".agent-annotations");
  }

  return { ok: true, workspaceRoot, runtimeRoot, session };
};

const requiredPath = (
  raw: string,
  label: "workspace root" | "runtime root"
): { ok: true; value: string } | { ok: false; message: string } => {
  const canonical = canonicalPath(raw);
  if (!existsSync(canonical)) {
    return { ok: false, message: `${label} does not exist: ${canonical}` };
  }
  return { ok: true, value: canonical };
};
