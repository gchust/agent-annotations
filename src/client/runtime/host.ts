import { localeMessages } from "../messages.js";
import type {
  AgentAnnotationsCaptureMode,
  AgentAnnotationsHostTheme,
  AgentAnnotationsPageContext,
  AgentAnnotationsRect,
  HostIntegration,
  StudioPublicSnapshot,
} from "../../types/index.js";
import type { ClientExtensionRegistry } from "../../extension/index.js";

type ComposerState =
  | { kind: "element" | "multi"; elements: Element[] }
  | { kind: "region"; rect: AgentAnnotationsRect; sampled: number; elements: Element[] };

// Focused host-controller bindings: dynamic mount values are read and
// written through narrow getters/setters.
export type HostBindings = {
  host(): HostIntegration | undefined;
  hostTheme(): AgentAnnotationsHostTheme;
  setHostTheme(value: AgentAnnotationsHostTheme): void;
  hostLocale(): string;
  setHostLocale(value: string): void;
  messages(): Record<string, string>;
  setMessages(value: Record<string, string>): void;
  appRoot(): Element | Document;
  setAppRoot(value: Element | Document): void;
  routeKey(): string;
  setRouteKey(value: string): void;
  pageContext(): AgentAnnotationsPageContext;
  shortcuts(): StudioPublicSnapshot["shortcuts"];
  setShortcuts(value: StudioPublicSnapshot["shortcuts"]): void;
  captureMode(): AgentAnnotationsCaptureMode;
  setCaptureMode(value: AgentAnnotationsCaptureMode): void;
  selected(): Element[];
  setSelected(value: Element[]): void;
  hover(): Element | null;
  setHover(value: Element | null): void;
  areaStart(): { x: number; y: number } | null;
  setAreaStart(value: { x: number; y: number } | null): void;
  areaRect(): AgentAnnotationsRect | null;
  setAreaRect(value: AgentAnnotationsRect | null): void;
  composer(): ComposerState | null;
  setComposer(value: ComposerState | null): void;
  editingId(): string | null;
  setEditingId(value: string | null): void;
  editorAnchorRect(): AgentAnnotationsRect | null;
  setEditorAnchorRect(value: AgentAnnotationsRect | null): void;
  registry(): ClientExtensionRegistry;
  hostElement(): HTMLElement;
  root(): HTMLElement;
  destroyed(): boolean;
  buildShortcuts(): StudioPublicSnapshot["shortcuts"];
  setMarkerHighlight(id: string | null): void;
  resetTrackedTargets(): void;
  setInspectionFrozen(frozen: boolean, targets?: Element[]): void;
  clearCaptureDocuments(): void;
  refreshCaptureDocuments(): void;
  scheduleMarkerRefresh(): void;
  scheduleFrame(callback: () => void): number;
  render(): void;
  emit(): void;
};

export type HostController = {
  applyTheme(): void;
  refreshSystemThemeListener(): void;
  applyHostChange(): void;
  applyRouteKey(next: string): void;
  refreshRoute(): void;
  disposeSystemTheme(): void;
};

export const createHostController = (b: HostBindings): HostController => {
  let systemThemeCleanup: (() => void) | null = null;
  const effectiveTheme = (): "light" | "dark" => {
    const theme = b.hostTheme();
    return theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  };
  const applyTheme = (): void => {
    b.hostElement().dataset.theme = effectiveTheme();
  };
  const refreshSystemThemeListener = (): void => {
    const needsSystem = b.hostTheme() === "system";
    if (needsSystem && !systemThemeCleanup) {
      const query = window.matchMedia?.("(prefers-color-scheme: dark)");
      if (query) {
        const onChange = (): void => {
          if (b.destroyed() || b.hostTheme() !== "system") return;
          applyTheme();
        };
        query.addEventListener("change", onChange);
        systemThemeCleanup = () => query.removeEventListener("change", onChange);
      }
    } else if (!needsSystem && systemThemeCleanup) {
      systemThemeCleanup();
      systemThemeCleanup = null;
    }
  };
  const applyRouteKey = (next: string) => {
    if (b.destroyed() || next === b.routeKey()) return;
    b.setRouteKey(next);
    // Old-route transient state never survives: the temporary highlight and
    // the editor anchor rect belong to the previous route.
    b.setMarkerHighlight(null);
    b.setEditorAnchorRect(null);
    if (b.captureMode() !== "idle" || b.composer() || b.editingId()) {
      // Never persist old-route capture state under the new route key.
      b.setInspectionFrozen(false);
      b.clearCaptureDocuments();
      b.setCaptureMode("idle");
      b.setSelected([]);
      b.setHover(null);
      b.setAreaStart(null);
      b.setAreaRect(null);
      b.setComposer(null);
      b.setEditingId(null);
    }
    b.scheduleFrame(() => {
      b.render();
      b.emit();
    });
  };
  const applyHostChange = (): void => {
    if (b.destroyed()) return;
    const nextTheme = b.host()?.theme?.() ?? "light";
    if (nextTheme !== b.hostTheme()) {
      b.setHostTheme(nextTheme);
      refreshSystemThemeListener();
      applyTheme();
    } else {
      refreshSystemThemeListener();
    }
    const nextLocale = b.host()?.locale?.() ?? (document.documentElement.lang || "en-US");
    const nextMessages = {
      ...localeMessages(nextLocale),
      ...b.registry().getMessages(),
      ...b.host()?.messages,
    };
    if (nextLocale !== b.hostLocale() || JSON.stringify(nextMessages) !== JSON.stringify(b.messages())) {
      b.setHostLocale(nextLocale);
      b.setMessages(nextMessages);
      b.root().lang = b.hostLocale();
      b.setShortcuts(b.buildShortcuts());
      b.render();
      b.emit();
    }
    const nextAppRoot = b.host()?.appRoot?.() ?? document.body;
    if (nextAppRoot !== b.appRoot()) {
      b.setAppRoot(nextAppRoot);
      b.resetTrackedTargets();
      if (b.captureMode() !== "idle") {
        b.refreshCaptureDocuments();
      }
      b.scheduleMarkerRefresh();
      b.scheduleFrame(() => {
        b.render();
        b.emit();
      });
    }
    applyRouteKey(b.pageContext().routeKey);
  };
  const refreshRoute = () => applyRouteKey(b.pageContext().routeKey);

  return {
    applyTheme,
    refreshSystemThemeListener,
    applyHostChange,
    applyRouteKey,
    refreshRoute,
    disposeSystemTheme: () => {
      systemThemeCleanup?.();
      systemThemeCleanup = null;
    },
  };
};
