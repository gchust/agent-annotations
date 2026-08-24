import type {
  AgentAnnotationsBuiltinActionId,
  AgentAnnotationsBuiltinsConfig,
  AgentAnnotationsDiagnosticsConfig,
  AgentAnnotationsInitialState,
} from "../types/index.js";

// JSON-safe configuration boundary for the builtins and initialState options,
// shared by the Vite plugin and mountAgentAnnotations. Only known keys with
// boolean/plain-object values are accepted; unknown keys and non-JSON values
// are rejected so the serialized virtual-client config can never contain
// executable input.

const BUILTIN_ACTION_IDS: readonly AgentAnnotationsBuiltinActionId[] = [
  "pick",
  "multi",
  "area",
  "copy",
  "clear",
  "markers",
  "help",
  "list",
  "collapse",
];

const SHORTCUT_FIELDS = new Set(["key", "code", "primary", "alt", "shift"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// Strict JSON-safe shortcut shape: false removes the shortcut; otherwise a
// plain object with a non-empty key, an optional non-empty code, and boolean
// primary/alt/shift (mirroring the registry's own shortcut validation).
const validateBuiltinShortcut = (value: unknown, actionId: string): void => {
  if (value === false) return;
  if (!isPlainObject(value)) {
    throw new TypeError(`builtins shortcuts.${actionId} must be a plain object or false`);
  }
  for (const key of Object.keys(value)) {
    if (!SHORTCUT_FIELDS.has(key)) {
      throw new TypeError(`unknown builtins shortcut field: ${actionId}.${key}`);
    }
  }
  if (typeof value.key !== "string" || value.key.length === 0) {
    throw new TypeError(`builtins shortcuts.${actionId}.key must be a non-empty string`);
  }
  if (value.code !== undefined && (typeof value.code !== "string" || value.code.length === 0)) {
    throw new TypeError(`builtins shortcuts.${actionId}.code must be a non-empty string`);
  }
  for (const field of ["primary", "alt", "shift"] as const) {
    if (typeof value[field] !== "boolean") {
      throw new TypeError(`builtins shortcuts.${actionId}.${field} must be a boolean`);
    }
  }
};

export const validateAgentAnnotationsBuiltinsConfig = (
  input: unknown
): AgentAnnotationsBuiltinsConfig => {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) {
    throw new TypeError("builtins must be a plain object or false");
  }
  for (const key of Object.keys(input)) {
    if (key !== "shortcuts" && !BUILTIN_ACTION_IDS.includes(key as AgentAnnotationsBuiltinActionId)) {
      throw new TypeError(`unknown builtins option: ${key}`);
    }
  }
  const config: AgentAnnotationsBuiltinsConfig = {};
  for (const id of BUILTIN_ACTION_IDS) {
    const value = input[id];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`builtins ${id} must be a boolean`);
    }
    if (value !== undefined) config[id] = value;
  }
  if (input.shortcuts !== undefined) {
    if (!isPlainObject(input.shortcuts)) {
      throw new TypeError("builtins shortcuts must be a plain object");
    }
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.shortcuts)) {
      if (!BUILTIN_ACTION_IDS.includes(key as AgentAnnotationsBuiltinActionId)) {
        throw new TypeError(`unknown builtins shortcut: ${key}`);
      }
      validateBuiltinShortcut(value, key);
      if (value === false) {
        normalized[key] = false;
        continue;
      }
      // Normalize into a fresh exact object: no extra fields, no getters,
      // no toJSON, so later host mutation or serialization tricks cannot
      // change what the Vite virtual client receives.
      const source = value as Record<string, unknown>;
      const exact: Record<string, unknown> = {
        key: source.key,
        ...(source.code !== undefined ? { code: source.code } : {}),
        primary: source.primary,
        alt: source.alt,
        shift: source.shift,
      };
      normalized[key] = exact;
    }
    config.shortcuts = normalized as AgentAnnotationsBuiltinsConfig["shortcuts"];
  }
  return config;
};

export const validateAgentAnnotationsDiagnosticsConfig = (
  input: unknown
): AgentAnnotationsDiagnosticsConfig => {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) {
    throw new TypeError("diagnostics must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (key !== "console" && key !== "network") {
      throw new TypeError(`unknown diagnostics option: ${key}`);
    }
  }
  const config: AgentAnnotationsDiagnosticsConfig = {};
  if (input.console !== undefined) {
    if (typeof input.console !== "boolean") {
      throw new TypeError("diagnostics console must be a boolean");
    }
    config.console = input.console;
  }
  if (input.network !== undefined) {
    if (typeof input.network !== "boolean") {
      throw new TypeError("diagnostics network must be a boolean");
    }
    config.network = input.network;
  }
  return config;
};

export const validateAgentAnnotationsInitialState = (
  input: unknown
): AgentAnnotationsInitialState => {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) {
    throw new TypeError("initialState must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (key !== "collapsed" && key !== "markersVisible") {
      throw new TypeError(`unknown initialState option: ${key}`);
    }
  }
  const state: AgentAnnotationsInitialState = {};
  if (input.collapsed !== undefined) {
    if (typeof input.collapsed !== "boolean") {
      throw new TypeError("initialState collapsed must be a boolean");
    }
    state.collapsed = input.collapsed;
  }
  if (input.markersVisible !== undefined) {
    if (typeof input.markersVisible !== "boolean") {
      throw new TypeError("initialState markersVisible must be a boolean");
    }
    state.markersVisible = input.markersVisible;
  }
  return state;
};
