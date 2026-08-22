import {
  createAgentAnnotationsId,
  MAX_TARGETS_PER_ANNOTATION,
  toAgentAnnotationsDocumentRegion,
} from "../../core/index.js";
import { inspectTarget } from "../inspection-engine.js";
import type {
  AgentAnnotation,
  AgentAnnotationsDiagnosticPhase,
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

export const pageContext = (host?: HostIntegration) => ({
  url: location.href,
  routeKey: host?.routeKey?.() ?? `${location.pathname}${location.search}${location.hash}`,
  title: document.title,
  viewport: { width: innerWidth, height: innerHeight },
  scroll: { x: scrollX, y: scrollY },
});

export const now = (): string => new Date().toISOString();

export const regionAnnotation = async (
  rect: AgentAnnotationsRect,
  elements: Element[],
  comment: string,
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
    pageContext: pageContext(host),
    region: toAgentAnnotationsDocumentRegion(rect, { x: scrollX, y: scrollY }),
    targets,
    extensions,
  };
};

export const elementAnnotation = async (
  kind: "element" | "multi",
  elements: Element[],
  comment: string,
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
    pageContext: pageContext(host),
    targets,
    extensions,
  };
};
