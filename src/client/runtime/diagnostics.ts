import { redactAgentAnnotationsText } from "../../core/index.js";
import type {
  AgentAnnotationsDiagnosticPhase,
  AgentAnnotationsDiagnosticsEntry,
  AgentAnnotationsJsonObject,
} from "../../types/index.js";
import { safeErrorText, now } from "./annotated.js";
import { subscribeNetworkFailures } from "./net.js";
import type { ClientExtensionRegistry } from "../../extension/index.js";

const MAX_DIAGNOSTICS_ENTRIES = 20;
const MAX_EXTENSION_FAILURE_KEYS = 20;

// Focused diagnostics-controller bindings; dynamic mount values are read
// through lazy getters so the controller never evaluates mount-time TDZ or
// stale snapshots.
export type DiagnosticsBindings = {
  registry: ClientExtensionRegistry;
  transport(): {
    appendDiagnostics?(entries: AgentAnnotationsDiagnosticsEntry[]): Promise<void>;
  };
  scheduleFrame(callback: () => void): number;
  emit(): void;
  refreshChrome(): void;
  browserStatus(): { endpoint: string; token: string } | null;
  destroyed(): boolean;
};

export type DiagnosticsController = {
  diagnostics: AgentAnnotationsDiagnosticsEntry[];
  record(
    source: AgentAnnotationsDiagnosticsEntry["source"],
    value: unknown,
    details?: {
      extensionId?: string;
      contributionId?: string;
      phase?: AgentAnnotationsDiagnosticPhase;
      method?: string;
      url?: string;
      status?: number;
      transport?: "fetch" | "xhr";
    }
  ): void;
  recordExtensionFailure(
    extensionId: string,
    phase: AgentAnnotationsDiagnosticPhase,
    contributionId: string | undefined,
    error: unknown
  ): void;
  guardedPredicate<T>(
    extensionId: string,
    contributionId: string,
    phase: "visible" | "enabled" | "pressed",
    fallback: T,
    invoke: () => T
  ): T;
  guardedRedactors(): Array<{
    extensionId: string;
    id: string;
    redact(data: AgentAnnotationsJsonObject, context: { annotationId: string; extensionId: string }): AgentAnnotationsJsonObject | null;
  }>;
  onError(event: ErrorEvent): void;
  onRejection(event: PromiseRejectionEvent): void;
  onConsoleError(...values: unknown[]): void;
  installConsoleLogging(): () => void;
  installNetworkDiagnostics(): () => void;
};

export const createDiagnosticsController = (b: DiagnosticsBindings): DiagnosticsController => {
  const diagnostics: AgentAnnotationsDiagnosticsEntry[] = [];
  let diagnosticsEmitScheduled = false;
  let recording = false;
  const extensionFailureKeys = new Set<string>();

  const scheduleDiagnosticsEmit = (): void => {
    // Public state updates immediately, while the Chrome refresh is deferred
    // and coalesced so a contribution guard never re-enters React.
    b.emit();
    if (diagnosticsEmitScheduled) return;
    diagnosticsEmitScheduled = true;
    b.scheduleFrame(() => {
      diagnosticsEmitScheduled = false;
      if (!b.destroyed()) b.refreshChrome();
    });
  };

  const record: DiagnosticsController["record"] = (source, value, details) => {
    const entry: AgentAnnotationsDiagnosticsEntry = {
      source,
      message: redactAgentAnnotationsText(safeErrorText(value), { maxLength: 500 }),
      timestamp: now(),
      ...(details?.extensionId ? { extensionId: details.extensionId } : {}),
      ...(details?.contributionId ? { contributionId: details.contributionId } : {}),
      ...(details?.phase ? { phase: details.phase } : {}),
      ...(details?.method ? { method: details.method } : {}),
      ...(details?.url ? { url: details.url } : {}),
      ...(details?.status !== undefined ? { status: details.status } : {}),
      ...(details?.transport ? { transport: details.transport } : {}),
    };
    diagnostics.push(entry);
    if (diagnostics.length > MAX_DIAGNOSTICS_ENTRIES) diagnostics.shift();
    scheduleDiagnosticsEmit();
    // Persisting diagnostics stays allowed even while the runtime is
    // destroyed (dispose failures must still reach the server), but the UI
    // emit is guarded above. The append promise is explicitly handled.
    const append = b.transport().appendDiagnostics?.([entry]);
    if (append) {
      append.catch(() => undefined);
    }
  };

  // Deduplicated, bounded diagnostics for third-party contribution failures:
  // one entry per (extensionId, phase, contributionId) at the diagnostics
  // capacity; new keys after capacity are ignored so high-frequency predicate
  // errors can never flood diagnostics.
  const recordExtensionFailure = (
    extensionId: string,
    phase: AgentAnnotationsDiagnosticPhase,
    contributionId: string | undefined,
    error: unknown
  ): void => {
    const key = `${extensionId}|${phase}|${contributionId ?? ""}`;
    if (extensionFailureKeys.has(key)) return;
    if (extensionFailureKeys.size >= MAX_EXTENSION_FAILURE_KEYS) return;
    extensionFailureKeys.add(key);
    record("extension", `${phase} failed for ${extensionId}${contributionId ? `:${contributionId}` : ""}: ${safeErrorText(error)}`, {
      extensionId,
      contributionId,
      phase,
    });
  };

  const guardedPredicate = <T>(
    extensionId: string,
    contributionId: string,
    phase: "visible" | "enabled" | "pressed",
    fallback: T,
    invoke: () => T
  ): T => {
    try {
      return invoke();
    } catch (error) {
      recordExtensionFailure(extensionId, phase, contributionId, error);
      return fallback;
    }
  };

  const guardedRedactors = () =>
    b.registry.getRedactors().map((redactor) => ({
      extensionId: redactor.extensionId,
      id: redactor.id,
      redact: (data: AgentAnnotationsJsonObject, context: { annotationId: string; extensionId: string }) => {
        try {
          return redactor.redact(data, context);
        } catch (error) {
          recordExtensionFailure(redactor.extensionId, "redact", redactor.id, error);
          throw error;
        }
      },
    }));

  const onError = (event: ErrorEvent) => record("window", event.message);
  const onRejection = (event: PromiseRejectionEvent) => record("promise", event.reason);
  const originalConsoleError = console.error;
  const onConsoleError = (...values: unknown[]) => {
    originalConsoleError.apply(console, values);
    if (recording) return;
    recording = true;
    try {
      record("console", values.map((value) => safeErrorText(value)).join(" "));
    } finally {
      recording = false;
    }
  };
  const installConsoleLogging = (): (() => void) => {
    console.error = onConsoleError;
    return () => {
      if (console.error === onConsoleError) console.error = originalConsoleError;
    };
  };

  // Safe network failure capture: origin+path only (no query/hash), never
  // bodies/headers/auth, and this package's own endpoint is suppressed. The
  // shared patch is ref-counted process-wide, so simultaneous or repeated
  // mounts never stack wrappers and callbacks go inert once this mount
  // unsubscribes.
  const sanitizeNetworkUrl = (raw: string): string => {
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  };
  const isOwnEndpoint = (raw: string): boolean => {
    const status = b.browserStatus();
    if (!status) return false;
    try {
      const endpoint = new URL(status.endpoint, window.location.href);
      const target = new URL(raw, window.location.href);
      return target.origin === endpoint.origin
        && (target.pathname === endpoint.pathname || target.pathname.startsWith(`${endpoint.pathname}/`));
    } catch {
      return false;
    }
  };
  const recordNetwork = (
    transport: "fetch" | "xhr",
    method: string,
    rawUrl: string,
    status: number | undefined,
    detail: string | null
  ): void => {
    if (b.destroyed()) return;
    if (!rawUrl) return;
    const url = sanitizeNetworkUrl(rawUrl);
    if (!url || isOwnEndpoint(rawUrl)) return;
    if (method.length === 0 || method.length > 16 || !/^[A-Z]+$/.test(method)) return;
    if (url.length > 2000) return;
    const suffix = status !== undefined
      ? ` failed (${status})`
      : ` failed (${detail ?? "network error"})`;
    record("network", `${transport} ${method} ${url}${suffix}`, {
      method,
      url,
      ...(status !== undefined ? { status } : {}),
      transport,
    });
  };
  const installNetworkDiagnostics = (): (() => void) => {
    return subscribeNetworkFailures((failure) => {
      recordNetwork(failure.transport, failure.method, failure.rawUrl, failure.status, failure.detail);
    });
  };

  return {
    diagnostics,
    record,
    recordExtensionFailure,
    guardedPredicate,
    guardedRedactors,
    onError,
    onRejection,
    onConsoleError,
    installConsoleLogging,
    installNetworkDiagnostics,
  };
};
