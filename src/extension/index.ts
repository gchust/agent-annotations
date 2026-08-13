import type {
  AgentFeedbackClientExtension,
  AgentFeedbackLocaleMessages,
  FeedbackExporter,
  FeedbackRedactor,
  HostIntegration,
  PanelContribution,
  TargetEnricher,
  ToolbarContribution,
} from "../types/index.js";

export const agentFeedbackExtensionApiVersion = 1 as const;

type Registered<T> = T & { readonly extensionId: string };
type RegisteredToolbarContribution = Registered<ToolbarContribution>;
type RegisteredPanelContribution = Registered<PanelContribution>;
type RegisteredTargetEnricher = Registered<TargetEnricher>;
type RegisteredFeedbackExporter = Registered<FeedbackExporter>;
type RegisteredFeedbackRedactor = Registered<FeedbackRedactor>;

const GROUP_ORDER = ["capture", "handoff", "view", "host"] as const;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const assertId: (kind: string, value: unknown) => asserts value is string = (
  kind,
  value
) => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${kind} ID: ${String(value)}`);
  }
};

const isText = (value: unknown): boolean =>
  typeof value === "string"
    ? value.length > 0
    : !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0 &&
      Object.values(value).every(
        (message) => typeof message === "string" && message.length > 0
      );

const shortcutKeys = (
  shortcut: ToolbarContribution["shortcut"],
  contributionId?: string
): string[] => {
  if (!shortcut) return [];
  if (
    typeof shortcut.key !== "string" ||
    shortcut.key.length === 0 ||
    (shortcut.code !== undefined &&
      (typeof shortcut.code !== "string" || shortcut.code.length === 0)) ||
    typeof shortcut.primary !== "boolean" ||
    typeof shortcut.alt !== "boolean" ||
    typeof shortcut.shift !== "boolean"
  ) {
    throw new TypeError(
      contributionId
        ? `Invalid toolbar shortcut: ${contributionId}`
        : "Invalid toolbar shortcut"
    );
  }
  const modifiers = `${Number(shortcut.primary)}${Number(shortcut.alt)}${Number(
    shortcut.shift
  )}`;
  return [
    `${modifiers}:key:${shortcut.key.toUpperCase()}`,
    ...(shortcut.code
      ? [`${modifiers}:code:${shortcut.code.toUpperCase()}`]
      : []),
  ];
};

const assertList = <T extends { id: string }>(
  kind: string,
  values: readonly T[] | undefined,
  validate: (value: T) => boolean
): void => {
  if (values !== undefined && !Array.isArray(values)) {
    throw new TypeError(`Invalid ${kind} contributions`);
  }
  for (const value of values ?? []) {
    if (!value || typeof value !== "object") {
      throw new TypeError(`Invalid ${kind} contribution`);
    }
    assertId(kind, value.id);
    if (!validate(value)) throw new TypeError(`Invalid ${kind}: ${value.id}`);
  }
};

const validateExtension = (extension: AgentFeedbackClientExtension): void => {
  if (!extension || typeof extension !== "object") {
    throw new TypeError("Invalid client extension");
  }
  assertId("extension", extension.id);
  if (extension.apiVersion !== agentFeedbackExtensionApiVersion) {
    throw new TypeError(
      `Unsupported client extension API version: ${String(extension.apiVersion)}`
    );
  }
  if (extension.setup !== undefined && typeof extension.setup !== "function") {
    throw new TypeError(`Invalid extension setup: ${extension.id}`);
  }
  assertList("toolbar contribution", extension.toolbar, (toolbar) => {
    if (!GROUP_ORDER.includes(toolbar.group)) {
      throw new TypeError(`Invalid toolbar group: ${String(toolbar.group)}`);
    }
    if (!isText(toolbar.label)) {
      throw new TypeError(`Invalid toolbar label: ${toolbar.id}`);
    }
    if (toolbar.order !== undefined && !Number.isFinite(toolbar.order)) {
      throw new TypeError(`Invalid toolbar order: ${toolbar.id}`);
    }
    if (toolbar.shortcut) shortcutKeys(toolbar.shortcut, toolbar.id);
    if (toolbar.kind === "panel") {
      assertId("toolbar panel", toolbar.panelId);
    }
    return (
      typeof toolbar.icon === "function" &&
      ["action", "toggle", "panel"].includes(toolbar.kind) &&
      (toolbar.execute === undefined || typeof toolbar.execute === "function") &&
      (toolbar.kind === "panel" || typeof toolbar.execute === "function") &&
      [toolbar.isVisible, toolbar.isEnabled, toolbar.isPressed].every(
        (callback) => callback === undefined || typeof callback === "function"
      )
    );
  });
  assertList(
    "panel",
    extension.panels,
    (panel) =>
      isText(panel.title) &&
      typeof panel.render === "function" &&
      (panel.placement === undefined ||
        ["above", "below", "auto"].includes(panel.placement)) &&
      (panel.exclusiveGroup === undefined ||
        (typeof panel.exclusiveGroup === "string" && panel.exclusiveGroup.length > 0))
  );
  assertList(
    "target enricher",
    extension.targetEnrichers,
    (enricher) => typeof enricher.enrich === "function"
  );
  assertList(
    "exporter",
    extension.exporters,
    (exporter) => typeof exporter.export === "function"
  );
  assertList(
    "redactor",
    extension.redactors,
    (redactor) => typeof redactor.redact === "function"
  );
  if (
    extension.messages !== undefined &&
    (typeof extension.messages !== "object" ||
      Array.isArray(extension.messages) ||
      !Object.values(extension.messages).every(
        (message) => typeof message === "string"
      ))
  ) {
    throw new TypeError(`Invalid extension messages: ${extension.id}`);
  }
  if (extension.host !== undefined) {
    if (!extension.host || typeof extension.host !== "object") {
      throw new TypeError(`Invalid host integration: ${extension.id}`);
    }
    for (const callback of ["locale", "routeKey", "identity"] as const) {
      if (
        extension.host[callback] !== undefined &&
        typeof extension.host[callback] !== "function"
      ) {
        throw new TypeError(`Invalid host ${callback}: ${extension.id}`);
      }
    }
    if (
      extension.host.messages !== undefined &&
      (typeof extension.host.messages !== "object" ||
        Array.isArray(extension.host.messages) ||
        !Object.values(extension.host.messages).every(
          (message) => typeof message === "string"
        ))
    ) {
      throw new TypeError(`Invalid host messages: ${extension.id}`);
    }
  }
};

const byId = <T extends { id: string }>(left: T, right: T): number =>
  left.id.localeCompare(right.id);

export class ClientExtensionRegistry {
  readonly #extensions = new Map<string, AgentFeedbackClientExtension>();
  readonly #toolbar = new Map<string, RegisteredToolbarContribution>();
  readonly #panels = new Map<string, RegisteredPanelContribution>();
  readonly #enrichers = new Map<string, RegisteredTargetEnricher>();
  readonly #exporters = new Map<string, RegisteredFeedbackExporter>();
  readonly #redactors = new Map<string, RegisteredFeedbackRedactor>();
  readonly #shortcutKeys = new Map<string, string>();
  readonly #shortcutCodes = new Map<string, string>();
  #host: { extensionId: string; value: HostIntegration } | undefined;

  register(extension: AgentFeedbackClientExtension): () => void {
    validateExtension(extension);
    if (this.#extensions.has(extension.id)) {
      throw new TypeError(`Duplicate extension ID: ${extension.id}`);
    }
    if (extension.host && this.#host) {
      throw new TypeError(
        `Duplicate host integration: ${extension.id} conflicts with ${this.#host.extensionId}`
      );
    }

    const assertUnique = (
      kind: string,
      values: readonly { id: string }[],
      registered: Map<string, unknown>
    ): void => {
      const pending = new Set<string>();
      for (const value of values) {
        if (registered.has(value.id) || pending.has(value.id)) {
          throw new TypeError(`Duplicate ${kind} ID: ${value.id}`);
        }
        pending.add(value.id);
      }
    };
    assertUnique("toolbar contribution", extension.toolbar ?? [], this.#toolbar);
    assertUnique("panel", extension.panels ?? [], this.#panels);
    assertUnique("target enricher", extension.targetEnrichers ?? [], this.#enrichers);
    assertUnique("exporter", extension.exporters ?? [], this.#exporters);
    assertUnique("redactor", extension.redactors ?? [], this.#redactors);

    const pendingKeys = new Map<string, string>();
    const pendingCodes = new Map<string, string>();
    for (const toolbar of extension.toolbar ?? []) {
      if (
        toolbar.panelId &&
        !this.#panels.has(toolbar.panelId) &&
        !(extension.panels ?? []).some((panel) => panel.id === toolbar.panelId)
      ) {
        throw new TypeError(`Unknown toolbar panel ID: ${toolbar.panelId}`);
      }
      const [key, code] = shortcutKeys(toolbar.shortcut, toolbar.id);
      const conflict = [
        key && (this.#shortcutKeys.get(key) ?? pendingKeys.get(key)),
        code && (this.#shortcutCodes.get(code) ?? pendingCodes.get(code)),
      ]
        .find(Boolean);
      if (conflict) {
        throw new TypeError(
          `Duplicate toolbar shortcut: ${toolbar.id} conflicts with ${conflict}`
        );
      }
      if (key) pendingKeys.set(key, toolbar.id);
      if (code) pendingCodes.set(code, toolbar.id);
    }

    const add = <T extends { id: string }>(
      values: readonly T[] | undefined,
      registered: Map<string, Registered<T>>
    ): void => {
      for (const value of values ?? []) {
        registered.set(value.id, { ...value, extensionId: extension.id });
      }
    };
    this.#extensions.set(extension.id, extension);
    add(extension.toolbar, this.#toolbar);
    add(extension.panels, this.#panels);
    add(extension.targetEnrichers, this.#enrichers);
    add(extension.exporters, this.#exporters);
    add(extension.redactors, this.#redactors);
    for (const [key, id] of pendingKeys) this.#shortcutKeys.set(key, id);
    for (const [code, id] of pendingCodes) this.#shortcutCodes.set(code, id);
    if (extension.host) {
      this.#host = { extensionId: extension.id, value: extension.host };
    }

    let registered = true;
    return () => {
      if (!registered || this.#extensions.get(extension.id) !== extension) return;
      registered = false;
      this.#extensions.delete(extension.id);
      const remove = (
        values: readonly { id: string }[] | undefined,
        contributions: Map<string, unknown>
      ): void => {
        for (const value of values ?? []) contributions.delete(value.id);
      };
      remove(extension.toolbar, this.#toolbar);
      remove(extension.panels, this.#panels);
      remove(extension.targetEnrichers, this.#enrichers);
      remove(extension.exporters, this.#exporters);
      remove(extension.redactors, this.#redactors);
      for (const toolbar of extension.toolbar ?? []) {
        const [key, code] = shortcutKeys(toolbar.shortcut, toolbar.id);
        if (key) this.#shortcutKeys.delete(key);
        if (code) this.#shortcutCodes.delete(code);
      }
      if (this.#host?.extensionId === extension.id) this.#host = undefined;
    };
  }

  getExtensions(): readonly AgentFeedbackClientExtension[] {
    return [...this.#extensions.values()].sort(byId);
  }

  getToolbarContributions(): readonly RegisteredToolbarContribution[] {
    return [...this.#toolbar.values()].sort(
      (left, right) =>
        GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group) ||
        (left.order ?? 0) - (right.order ?? 0) ||
        byId(left, right)
    );
  }

  getPanels(): readonly RegisteredPanelContribution[] {
    return [...this.#panels.values()].sort(byId);
  }

  getTargetEnrichers(): readonly RegisteredTargetEnricher[] {
    return [...this.#enrichers.values()].sort(byId);
  }

  getExporters(): readonly RegisteredFeedbackExporter[] {
    return [...this.#exporters.values()].sort(byId);
  }

  getRedactors(): readonly RegisteredFeedbackRedactor[] {
    return [...this.#redactors.values()].sort(byId);
  }

  getMessages(): AgentFeedbackLocaleMessages {
    return Object.assign(
      {},
      ...this.getExtensions().map((extension) => extension.messages ?? {})
    );
  }

  getHostIntegration(): HostIntegration | undefined {
    return this.#host?.value;
  }
}

export const registerClientExtension = (
  registry: ClientExtensionRegistry,
  extension: AgentFeedbackClientExtension
): (() => void) => registry.register(extension);

export const defineClientExtension = <T extends AgentFeedbackClientExtension>(
  extension: T
): T => extension;

export type {
  AgentFeedbackClientExtension,
  AgentFeedbackExtensionContext,
  AgentFeedbackIconProps as IconProps,
  AgentFeedbackLocalizedText as LocalizedText,
  AgentFeedbackLocaleMessages as LocaleMessages,
  AgentFeedbackToolbarShortcut as ShortcutDefinition,
  FeedbackExporter,
  FeedbackRedactor,
  HostIntegration,
  PanelContribution,
  StudioPublicApi,
  StudioPublicSnapshot,
  TargetEnricher,
  ToolbarCommandContext,
  ToolbarContribution,
} from "../types/index.js";
