export const agentFeedbackExtensionApiVersion = 1 as const;

export type ClientExtensionShortcut = {
  key: string;
  code?: string;
  primary: boolean;
  alt: boolean;
  shift: boolean;
};

export type ClientExtensionToolbarContribution = {
  id: string;
  group: "capture" | "handoff" | "view" | "host";
  order?: number;
  label: string;
  kind: "action" | "toggle" | "panel";
  shortcut?: ClientExtensionShortcut;
};

export type AgentFeedbackClientExtension = {
  id: string;
  apiVersion: 1;
  toolbar?: readonly ClientExtensionToolbarContribution[];
};

export type RegisteredToolbarContribution = ClientExtensionToolbarContribution & {
  extensionId: string;
};

const GROUP_ORDER = ["capture", "handoff", "view", "host"] as const;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const assertId: (kind: string, value: unknown) => asserts value is string = (kind, value) => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${kind} ID: ${String(value)}`);
  }
};

const shortcutKeys = (shortcut: ClientExtensionShortcut): string[] => {
  if (
    typeof shortcut.key !== "string" ||
    shortcut.key.length === 0 ||
    (shortcut.code !== undefined && (typeof shortcut.code !== "string" || shortcut.code.length === 0)) ||
    typeof shortcut.primary !== "boolean" ||
    typeof shortcut.alt !== "boolean" ||
    typeof shortcut.shift !== "boolean"
  ) {
    throw new TypeError("Invalid toolbar shortcut");
  }
  const modifiers = `${Number(shortcut.primary)}${Number(shortcut.alt)}${Number(shortcut.shift)}`;
  return [
    `${modifiers}:key:${shortcut.key.toUpperCase()}`,
    ...(shortcut.code ? [`${modifiers}:code:${shortcut.code}`] : []),
  ];
};

const validateToolbar: (
  value: unknown
) => asserts value is readonly ClientExtensionToolbarContribution[] = (value) => {
  if (!Array.isArray(value)) throw new TypeError("Invalid toolbar contributions");
  for (const contribution of value) {
    if (!contribution || typeof contribution !== "object") {
      throw new TypeError("Invalid toolbar contribution");
    }
    const candidate = contribution as Partial<ClientExtensionToolbarContribution>;
    assertId("toolbar contribution", candidate.id);
    if (!GROUP_ORDER.includes(candidate.group as never)) {
      throw new TypeError(`Invalid toolbar group: ${String(candidate.group)}`);
    }
    if (typeof candidate.label !== "string" || candidate.label.length === 0) {
      throw new TypeError(`Invalid toolbar label: ${candidate.id}`);
    }
    if (!(["action", "toggle", "panel"] as const).includes(candidate.kind as never)) {
      throw new TypeError(`Invalid toolbar kind: ${candidate.id}`);
    }
    if (candidate.order !== undefined && !Number.isFinite(candidate.order)) {
      throw new TypeError(`Invalid toolbar order: ${candidate.id}`);
    }
    if (candidate.shortcut !== undefined) shortcutKeys(candidate.shortcut);
  }
};

export class ClientExtensionRegistry {
  readonly #extensions = new Map<string, AgentFeedbackClientExtension>();
  readonly #toolbar = new Map<string, RegisteredToolbarContribution>();
  readonly #shortcuts = new Map<string, string>();

  register(extension: AgentFeedbackClientExtension): () => void {
    if (!extension || typeof extension !== "object") {
      throw new TypeError("Invalid client extension");
    }
    assertId("extension", extension.id);
    if (extension.apiVersion !== agentFeedbackExtensionApiVersion) {
      throw new TypeError(`Unsupported client extension API version: ${String(extension.apiVersion)}`);
    }
    validateToolbar(extension.toolbar ?? []);

    if (this.#extensions.has(extension.id)) {
      throw new TypeError(`Duplicate extension ID: ${extension.id}`);
    }

    const pendingIds = new Set<string>();
    const pendingShortcuts = new Map<string, string>();
    for (const contribution of extension.toolbar ?? []) {
      if (this.#toolbar.has(contribution.id) || pendingIds.has(contribution.id)) {
        throw new TypeError(`Duplicate toolbar contribution ID: ${contribution.id}`);
      }
      pendingIds.add(contribution.id);
      for (const key of contribution.shortcut ? shortcutKeys(contribution.shortcut) : []) {
        const conflict = this.#shortcuts.get(key) ?? pendingShortcuts.get(key);
        if (conflict) {
          throw new TypeError(`Duplicate toolbar shortcut: ${contribution.id} conflicts with ${conflict}`);
        }
        pendingShortcuts.set(key, contribution.id);
      }
    }

    this.#extensions.set(extension.id, extension);
    for (const contribution of extension.toolbar ?? []) {
      this.#toolbar.set(contribution.id, { ...contribution, extensionId: extension.id });
    }
    for (const [key, id] of pendingShortcuts) this.#shortcuts.set(key, id);

    let registered = true;
    return () => {
      if (!registered || this.#extensions.get(extension.id) !== extension) return;
      registered = false;
      this.#extensions.delete(extension.id);
      for (const contribution of extension.toolbar ?? []) {
        this.#toolbar.delete(contribution.id);
        for (const key of contribution.shortcut ? shortcutKeys(contribution.shortcut) : []) {
          this.#shortcuts.delete(key);
        }
      }
    };
  }

  getExtensions(): readonly AgentFeedbackClientExtension[] {
    return [...this.#extensions.values()];
  }

  getToolbarContributions(): readonly RegisteredToolbarContribution[] {
    return [...this.#toolbar.values()].sort(
      (left, right) =>
        GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group) ||
        (left.order ?? 0) - (right.order ?? 0) ||
        left.id.localeCompare(right.id)
    );
  }
}

export const defineClientExtension = <T extends AgentFeedbackClientExtension>(
  extension: T
): T => extension;
