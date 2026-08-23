import { AGENT_ANNOTATIONS_ID_PATTERN, createAgentAnnotationsId } from "../../core/index.js";

export type AgentAnnotationsBrowserSessionState = {
  runtimeId: string;
  browserUpdateRevision: number;
};

const STORAGE_PREFIX = "agent-annotations.browser-session.v1:";

export const browserSessionStorageKey = (endpoint: string): string =>
  `${STORAGE_PREFIX}${endpoint}`;

const storage = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

const parse = (value: string | null): AgentAnnotationsBrowserSessionState | null => {
  if (value === null) return null;
  try {
    const state = JSON.parse(value) as Record<string, unknown>;
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      Object.keys(state).length !== 2 ||
      typeof state.runtimeId !== "string" ||
      !AGENT_ANNOTATIONS_ID_PATTERN.test(state.runtimeId) ||
      typeof state.browserUpdateRevision !== "number" ||
      !Number.isSafeInteger(state.browserUpdateRevision) ||
      state.browserUpdateRevision < 0
    ) return null;
    return state as AgentAnnotationsBrowserSessionState;
  } catch {
    return null;
  }
};

export const saveBrowserSessionState = (
  endpoint: string,
  state: AgentAnnotationsBrowserSessionState
): void => {
  try {
    storage()?.setItem(browserSessionStorageKey(endpoint), JSON.stringify(state));
  } catch {
    // Session persistence is best-effort when browser storage is unavailable.
  }
};

export const restoreBrowserSessionState = (
  endpoint: string,
  requestedRuntimeId?: string
): AgentAnnotationsBrowserSessionState => {
  if (requestedRuntimeId !== undefined && !AGENT_ANNOTATIONS_ID_PATTERN.test(requestedRuntimeId)) {
    throw new TypeError("browserStatus runtimeId must be a valid runtime id");
  }
  let restored: AgentAnnotationsBrowserSessionState | null = null;
  try {
    restored = parse(storage()?.getItem(browserSessionStorageKey(endpoint)) ?? null);
  } catch {
    // Fall through to an in-memory state when browser storage is unavailable.
  }
  if (restored && (requestedRuntimeId === undefined || restored.runtimeId === requestedRuntimeId)) {
    return restored;
  }
  const state = {
    runtimeId: requestedRuntimeId ?? createAgentAnnotationsId(),
    browserUpdateRevision: 0,
  };
  saveBrowserSessionState(endpoint, state);
  return state;
};

export const clearBrowserSessionState = (endpoint: string): void => {
  try {
    storage()?.removeItem(browserSessionStorageKey(endpoint));
  } catch {
    // Explicit unmount still succeeds when browser storage is unavailable.
  }
};
