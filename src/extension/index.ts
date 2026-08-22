import type {
  AgentAnnotationsClientExtension,
  AgentAnnotationsLocaleMessages,
  AnnotationExporter,
  AnnotationRedactor,
  HostIntegration,
  PanelContribution,
  TargetEnricher,
  ToolbarContribution,
} from "../types/index.js";

export const agentAnnotationsExtensionApiVersion = 1 as const;

type Registered<T> = T & { readonly extensionId: string; readonly id: string };
type RegisteredToolbarContribution = Registered<ToolbarContribution>;
type RegisteredPanelContribution = Registered<PanelContribution>;
type RegisteredTargetEnricher = Registered<TargetEnricher>;
type RegisteredAnnotationExporter = Registered<AnnotationExporter>;
type RegisteredAnnotationRedactor = Registered<AnnotationRedactor>;
export type RegisteredHostIntegration = {
  readonly extensionId: string;
  readonly value: HostIntegration;
};

const canonical = (extensionId: string, localId: string): string =>
  `${extensionId}:${localId}`;

const GROUP_ORDER = ["capture", "handoff", "view", "host"] as const;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
// Same 64-character namespace limit the task schema applies to extension
// ids; local contribution ids share it so a canonical `extensionId:localId`
// always fits the persisted diagnostics contributionId bound (256).
const MAX_ID_LENGTH = 64;

const assertId: (kind: string, value: unknown) => asserts value is string = (
  kind,
  value
) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !ID_PATTERN.test(value)
  ) {
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

const configuredHostMessages = (host: HostIntegration | undefined): unknown => {
  if (!host) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(host, "messages");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const staticHostMessages = (host: HostIntegration | undefined): AgentAnnotationsLocaleMessages =>
  (configuredHostMessages(host) ?? {}) as AgentAnnotationsLocaleMessages;

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

const validateExtension = (extension: AgentAnnotationsClientExtension): void => {
  if (!extension || typeof extension !== "object") {
    throw new TypeError("Invalid client extension");
  }
  assertId("extension", extension.id);
  if (extension.apiVersion !== agentAnnotationsExtensionApiVersion) {
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
        ["above", "below", "auto"].includes(panel.placement))
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
    for (const callback of ["locale", "routeKey", "pageContext", "navigate", "subscribe", "identity", "theme", "appRoot"] as const) {
      if (
        extension.host[callback] !== undefined &&
        typeof extension.host[callback] !== "function"
      ) {
        throw new TypeError(`Invalid host ${callback}: ${extension.id}`);
      }
    }
    if (
      configuredHostMessages(extension.host) !== undefined &&
      (typeof configuredHostMessages(extension.host) !== "object" ||
        configuredHostMessages(extension.host) === null ||
        Array.isArray(configuredHostMessages(extension.host)) ||
        !Object.values(staticHostMessages(extension.host)).every(
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
  readonly #extensions = new Map<string, AgentAnnotationsClientExtension>();
  readonly #toolbar = new Map<string, RegisteredToolbarContribution>();
  readonly #panels = new Map<string, RegisteredPanelContribution>();
  readonly #enrichers = new Map<string, RegisteredTargetEnricher>();
  readonly #exporters = new Map<string, RegisteredAnnotationExporter>();
  readonly #redactors = new Map<string, RegisteredAnnotationRedactor>();
  readonly #shortcuts = new Map<string, string>();
  #host: RegisteredHostIntegration | undefined;

  register(extension: AgentAnnotationsClientExtension): () => void {
    validateExtension(extension);
    if (this.#extensions.has(extension.id)) {
      throw new TypeError(`Duplicate extension ID: ${extension.id}`);
    }
    if (extension.host && this.#host) {
      throw new TypeError(
        `Duplicate host integration: ${extension.id} conflicts with ${this.#host.extensionId}`
      );
    }
    if (extension.messages || configuredHostMessages(extension.host) !== undefined) {
      const ownKeys = new Set<string>();
      for (const source of [extension.messages ?? {}, staticHostMessages(extension.host)]) {
        for (const key of Object.keys(source)) {
          if (ownKeys.has(key)) {
            throw new TypeError(
              `Duplicate locale message key: ${key} (${extension.id} defines it in both messages and host.messages)`
            );
          }
          ownKeys.add(key);
        }
      }
      for (const key of ownKeys) {
        const existing = [...this.#extensions.values()].find(
          (registered) =>
            registered.messages?.[key] !== undefined ||
            staticHostMessages(registered.host)[key] !== undefined
        );
        if (existing) {
          throw new TypeError(
            `Duplicate locale message key: ${key} (${extension.id} conflicts with ${existing.id})`
          );
        }
      }
    }

    const assertUnique = (
      kind: string,
      values: readonly { id: string }[],
      registered: Map<string, unknown>
    ): void => {
      const pending = new Set<string>();
      for (const value of values) {
        const id = canonical(extension.id, value.id);
        if (registered.has(id) || pending.has(id)) {
          throw new TypeError(`Duplicate ${kind} ID: ${id}`);
        }
        pending.add(id);
      }
    };
    assertUnique("toolbar contribution", extension.toolbar ?? [], this.#toolbar);
    assertUnique("panel", extension.panels ?? [], this.#panels);
    assertUnique("target enricher", extension.targetEnrichers ?? [], this.#enrichers);
    assertUnique("exporter", extension.exporters ?? [], this.#exporters);
    assertUnique("redactor", extension.redactors ?? [], this.#redactors);

    const pendingShortcuts = new Map<string, string>();
    for (const toolbar of extension.toolbar ?? []) {
      if (toolbar.kind === "panel") {
        const panelId = canonical(extension.id, toolbar.panelId!);
        if (
          !this.#panels.has(panelId) &&
          !(extension.panels ?? []).some((panel) => canonical(extension.id, panel.id) === panelId)
        ) {
          throw new TypeError(`Unknown toolbar panel ID: ${panelId}`);
        }
      }
      for (const key of shortcutKeys(toolbar.shortcut, toolbar.id)) {
        const id = canonical(extension.id, toolbar.id);
        const conflict = this.#shortcuts.get(key) ?? pendingShortcuts.get(key);
        if (conflict) {
          throw new TypeError(
            `Duplicate toolbar shortcut: ${id} conflicts with ${conflict}`
          );
        }
        pendingShortcuts.set(key, id);
      }
    }

    const add = <T extends { id: string; panelId?: string }>(
      values: readonly T[] | undefined,
      registered: Map<string, Registered<T>>,
      resolvePanel = false
    ): void => {
      for (const value of values ?? []) {
        registered.set(canonical(extension.id, value.id), {
          ...value,
          ...(resolvePanel && value.panelId
            ? { panelId: canonical(extension.id, value.panelId) }
            : {}),
          extensionId: extension.id,
          id: canonical(extension.id, value.id),
        });
      }
    };
    this.#extensions.set(extension.id, extension);
    add(extension.toolbar, this.#toolbar, true);
    add(extension.panels, this.#panels);
    add(extension.targetEnrichers, this.#enrichers);
    add(extension.exporters, this.#exporters);
    add(extension.redactors, this.#redactors);
    for (const [key, id] of pendingShortcuts) this.#shortcuts.set(key, id);
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
        for (const value of values ?? []) {
          contributions.delete(canonical(extension.id, value.id));
        }
      };
      remove(extension.toolbar, this.#toolbar);
      remove(extension.panels, this.#panels);
      remove(extension.targetEnrichers, this.#enrichers);
      remove(extension.exporters, this.#exporters);
      remove(extension.redactors, this.#redactors);
      for (const toolbar of extension.toolbar ?? []) {
        for (const key of shortcutKeys(toolbar.shortcut, toolbar.id)) {
          this.#shortcuts.delete(key);
        }
      }
      if (this.#host?.extensionId === extension.id) this.#host = undefined;
    };
  }

  getExtensions(): readonly AgentAnnotationsClientExtension[] {
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

  getExporters(): readonly RegisteredAnnotationExporter[] {
    return [...this.#exporters.values()].sort(byId);
  }

  getRedactors(): readonly RegisteredAnnotationRedactor[] {
    return [...this.#redactors.values()].sort(
      (left, right) =>
        left.extensionId.localeCompare(right.extensionId) ||
        byId(left, right)
    );
  }

  getMessages(): AgentAnnotationsLocaleMessages {
    const messages: AgentAnnotationsLocaleMessages = {};
    for (const extension of this.getExtensions()) {
      for (const source of [extension.messages ?? {}, staticHostMessages(extension.host)]) {
        for (const [key, value] of Object.entries(source)) {
          if (key in messages) {
            throw new TypeError(`Duplicate locale message key: ${key}`);
          }
          messages[key] = value;
        }
      }
    }
    return messages;
  }

  getExtensionMessages(): AgentAnnotationsLocaleMessages {
    const messages: AgentAnnotationsLocaleMessages = {};
    for (const extension of this.getExtensions()) {
      Object.assign(messages, extension.messages);
    }
    return messages;
  }

  getHostRegistration(): RegisteredHostIntegration | undefined {
    return this.#host;
  }

  getHostIntegration(): HostIntegration | undefined {
    return this.#host?.value;
  }
}

export const registerClientExtension = (
  registry: ClientExtensionRegistry,
  extension: AgentAnnotationsClientExtension
): (() => void) => registry.register(extension);

export const defineClientExtension = <T extends AgentAnnotationsClientExtension>(
  extension: T
): T => extension;

export type {
  AgentAnnotationsClientExtension,
  AgentAnnotationsExtensionContext,
  AgentAnnotationsIconProps as IconProps,
  AgentAnnotationsLocalizedText as LocalizedText,
  AgentAnnotationsLocaleMessages as LocaleMessages,
  AgentAnnotationsToolbarShortcut as ShortcutDefinition,
  AnnotationExporter,
  AnnotationRedactor,
  HostIntegration,
  PanelContribution,
  StudioPublicApi,
  StudioPublicSnapshot,
  TargetEnricher,
  ToolbarCommandContext,
  ToolbarContribution,
} from "../types/index.js";
