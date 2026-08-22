import {
  createAgentAnnotationsId,
  MAX_TARGETS_PER_ANNOTATION,
  toAgentAnnotationsDocumentRegion,
} from "../../core/index.js";
import { inspectTarget } from "../inspection-engine.js";
import type {
  AgentAnnotation,
  AgentAnnotationsDiagnosticPhase,
  AgentAnnotationsPageContext,
  AgentAnnotationsPageContextOverride,
  AgentAnnotationsTarget,
  AgentAnnotationsRect,
  HostIntegration,
} from "../../types/index.js";

export const HOST_ID = "agent-annotations-root";
export const IGNORE_ATTRIBUTE = "data-react-grab-ignore";

// A third-party throw value can itself have a throwing toString; reduce it to
// text safely so isolation can never be pierced by error serialization. This
// is the single safe stringification path for third-party-controlled values.
export const safeErrorText = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "unknown error";
  }
};

export type RegisteredTargetEnricher = ReturnType<
  import("../../extension/index.js").ClientExtensionRegistry["getTargetEnrichers"]
>[number];

export type RegisteredToolbarContribution = ReturnType<
  import("../../extension/index.js").ClientExtensionRegistry["getToolbarContributions"]
>[number];

export type AgentAnnotationDiagnosticReporter = (
  message: string,
  details?: { extensionId?: string; contributionId?: string; phase?: AgentAnnotationsDiagnosticPhase }
) => void;

export const isEditable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return !!element?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName ?? "");
};

const REGION_TARGET_CONCURRENCY = 4;

const mapBounded = async <T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
};

const PAGE_URL_LIMIT = 2_048;
const PAGE_ROUTE_LIMIT = 500;
const PAGE_TITLE_LIMIT = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const boundedText = (value: unknown, limit: number, allowEmpty = false): string | null =>
  typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= limit &&
  !CONTROL_CHARACTERS.test(value)
    ? value
    : null;

const defaultPageContext = (): AgentAnnotationsPageContext => {
  const url = `${location.origin}${location.pathname}`;
  return {
    url: url.length <= PAGE_URL_LIMIT ? url : location.origin,
    routeKey: `${location.pathname}${location.hash.split("?", 1)[0]}`.slice(0, PAGE_ROUTE_LIMIT),
    title: document.title.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, PAGE_TITLE_LIMIT),
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
  };
};

const hostPageContext = (host: HostIntegration): AgentAnnotationsPageContextOverride => {
  const override = host.pageContext?.();
  const legacyRouteKey = override === undefined ? host.routeKey?.() : undefined;
  const value = override ?? (legacyRouteKey === undefined ? {} : { routeKey: legacyRouteKey });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pageContext must return an object");
  }
  if (Object.keys(value).some((key) => !["url", "routeKey", "title"].includes(key))) {
    throw new TypeError("pageContext contains an unknown field");
  }
  const result: AgentAnnotationsPageContextOverride = {};
  if (value.url !== undefined) {
    const url = boundedText(value.url, PAGE_URL_LIMIT);
    if (!url) throw new TypeError("pageContext.url must be a bounded string");
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || url.includes("?") || url.includes("#")) {
      throw new TypeError("pageContext.url must be http(s) without credentials, query, or fragment");
    }
    result.url = url;
  }
  if (value.routeKey !== undefined) {
    const routeKey = boundedText(value.routeKey, PAGE_ROUTE_LIMIT);
    if (!routeKey || routeKey.includes("?")) {
      throw new TypeError("pageContext.routeKey must be bounded and query-free");
    }
    result.routeKey = routeKey;
  }
  if (value.title !== undefined) {
    const title = boundedText(value.title, PAGE_TITLE_LIMIT, true);
    if (title === null) throw new TypeError("pageContext.title must be a bounded string");
    result.title = title;
  }
  return result;
};

export const createSafePageContext = (
  host?: HostIntegration,
  reportHostFailure?: (error: unknown) => void
): AgentAnnotationsPageContext => {
  const defaults = defaultPageContext();
  if (!host) return defaults;
  try {
    return { ...defaults, ...hostPageContext(host) };
  } catch (error) {
    reportHostFailure?.(new TypeError("invalid host page context"));
    return defaults;
  }
};

export const now = (): string => new Date().toISOString();

export const regionAnnotation = async (
  rect: AgentAnnotationsRect,
  elements: Element[],
  comment: string,
  context: AgentAnnotationsPageContext,
  host: HostIntegration | undefined,
  enrichers: readonly RegisteredTargetEnricher[],
  reportDiagnostic: AgentAnnotationDiagnosticReporter
): Promise<AgentAnnotation> => {
  const inspected = await mapBounded(
    elements,
    REGION_TARGET_CONCURRENCY,
    async (element) => {
      try {
        return { element, target: await inspectTarget(element, host) };
      } catch {
        // Uninspectable region elements are skipped; the region rect remains authoritative.
        return null;
      }
    }
  );
  const resolved = inspected
    .filter(
      (entry): entry is { element: Element; target: AgentAnnotationsTarget } => entry !== null
    )
    .slice(0, MAX_TARGETS_PER_ANNOTATION);
  const targets = resolved.map(({ target }) => target);
  const extensions: AgentAnnotation["extensions"] = {};
  for (const enricher of enrichers) {
    try {
      const values = await mapBounded(
        resolved,
        REGION_TARGET_CONCURRENCY,
        async ({ element, target }) =>
          enricher.enrich({ element, inspection: target.inspection })
      );
      const data = values.filter((value) => value !== null);
      if (data.length > 0) {
        extensions[enricher.extensionId] = {
          ...(extensions[enricher.extensionId] ?? {}),
          [enricher.id]: data.length === 1 ? data[0]! : { targets: data },
        };
      }
    } catch (error) {
      // A faulty enricher is skipped with a structured diagnostic; capture continues.
      reportDiagnostic(safeErrorText(error), {
        extensionId: enricher.extensionId,
        contributionId: enricher.id,
        phase: "enrich",
      });
    }
  }
  return {
    annotationId: createAgentAnnotationsId(),
    kind: "region",
    comment,
    status: "open",
    createdAt: now(),
    pageContext: context,
    region: toAgentAnnotationsDocumentRegion(rect, { x: scrollX, y: scrollY }),
    targets,
    extensions,
  };
};

export const elementAnnotation = async (
  kind: "element" | "multi",
  elements: Element[],
  comment: string,
  context: AgentAnnotationsPageContext,
  host: HostIntegration | undefined,
  enrichers: readonly RegisteredTargetEnricher[],
  reportDiagnostic: AgentAnnotationDiagnosticReporter
): Promise<AgentAnnotation> => {
  const targets = await Promise.all(elements.map((element) => inspectTarget(element, host)));
  const extensions: AgentAnnotation["extensions"] = {};
  for (const enricher of enrichers) {
    try {
      const values = await Promise.all(
        elements.map((element, index) =>
          enricher.enrich({ element, inspection: targets[index].inspection })
        )
      );
      const data = values.filter((value) => value !== null);
      if (data.length > 0) {
        extensions[enricher.extensionId] = {
          ...(extensions[enricher.extensionId] ?? {}),
          [enricher.id]: data.length === 1 ? data[0]! : { targets: data },
        };
      }
    } catch (error) {
      // A faulty enricher is skipped with a structured diagnostic; capture continues.
      reportDiagnostic(safeErrorText(error), {
        extensionId: enricher.extensionId,
        contributionId: enricher.id,
        phase: "enrich",
      });
    }
  }
  return {
    annotationId: createAgentAnnotationsId(),
    kind,
    comment,
    status: "open",
    createdAt: now(),
    pageContext: context,
    targets,
    extensions,
  };
};
