import {
  disposeBaselineStyles,
  freeze,
  getElementAtPoint,
  getElementBounds,
  getElementContext,
  getElementSelector,
  getElementsAtPoint,
  isElementGrabbable,
  unfreeze,
} from "react-grab/primitives";

import type {
  AgentFeedbackInspection,
  AgentFeedbackRect,
  AgentFeedbackSourceLocation,
  AgentFeedbackTarget,
  HostIntegration,
} from "../types/index.js";

const IGNORE = "[data-react-grab-ignore]";
const ROOTS = new Set(["html", "body"]);
const MAX_REGION_TARGETS = 50;
const MAX_REGION_CANDIDATES = 200;
export const REGION_SAMPLE_LIMIT = 69;
export const REGION_CANDIDATE_LIMIT = MAX_REGION_CANDIDATES;
export const REGION_TARGET_LIMIT = MAX_REGION_TARGETS;

const isCandidate = (element: Element): boolean =>
  element.isConnected &&
  !ROOTS.has(element.tagName.toLowerCase()) &&
  element.closest(IGNORE) === null &&
  isElementGrabbable(element);

const isRegionCandidate = (element: Element): boolean =>
  element.isConnected &&
  !ROOTS.has(element.tagName.toLowerCase()) &&
  element.closest(IGNORE) === null;

const boundsOf = (element: Element): AgentFeedbackRect => {
  const bounds = getElementBounds(element);
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
};

const text = (value: unknown, limit: number): string =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

const source = (value: {
  fileName?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
  functionName?: string | null;
  componentName?: string | null;
}): AgentFeedbackSourceLocation | null => {
  const filePath = value.filePath ?? value.fileName;
  if (!filePath || !value.lineNumber || value.columnNumber == null) return null;
  return {
    filePath,
    lineNumber: value.lineNumber,
    columnNumber: value.columnNumber + 1,
    componentName: value.componentName ?? value.functionName ?? null,
  };
};

const roleOf = (element: Element): string => {
  const explicit = element.getAttribute("role");
  if (explicit) return text(explicit, 100);
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "input") return "textbox";
  return "";
};

const nameOf = (element: Element): string =>
  text(
    element.getAttribute("aria-label") ??
      element.getAttribute("alt") ??
      element.getAttribute("title") ??
      element.textContent,
    500
  );

const attributesOf = (
  element: Element,
  host?: HostIntegration
): Record<string, string> => {
  const entries: Record<string, string> = {};
  if (element.id) entries.id = text(element.id, 500);
  const role = roleOf(element);
  const accessibleName = nameOf(element);
  if (role) entries.role = role;
  if (accessibleName) entries["aria-label"] = accessibleName;
  for (const [key, value] of Object.entries(host?.identity?.(element) ?? {})) {
    if (Object.keys(entries).length >= 50) break;
    if (key && value) entries[text(key, 100)] = text(value, 500);
  }
  return entries;
};

export const targetAtPoint = (x: number, y: number): Element | null =>
  getElementAtPoint(x, y, { filter: isCandidate });

export const targetFromEvent = (event: Event): Element | null => {
  const target = event.composedPath().find(
    (value): value is Element => !!value && typeof value === "object" && "tagName" in value
  );
  return target && isCandidate(target) ? target : null;
};

export async function inspectTarget(
  element: Element,
  host?: HostIntegration
): Promise<AgentFeedbackTarget> {
  const context = await getElementContext(element);
  const selector = getElementSelector(element);
  if (!selector) throw new Error("React Grab returned an empty selector");
  const sourceStack = context.stack
    .map((frame) => source(frame))
    .filter((frame): frame is AgentFeedbackSourceLocation => frame !== null)
    .slice(0, 12);
  const inspection: AgentFeedbackInspection = {
    tagName: element.tagName.toLowerCase(),
    role: roleOf(element),
    accessibleName: nameOf(element),
    text: text(element.textContent, 8000),
    componentName: context.componentName,
    source: source(context),
    sourceStack,
    htmlPreview: text(context.htmlPreview, 8000),
    styleText: text(context.styles, 8000),
    attributes: attributesOf(element, host),
  };
  return { selector, bounds: boundsOf(element), inspection };
}

export type TargetResolution =
  | { status: "resolved"; element: Element }
  | { status: "missing" | "ambiguous" | "invalid" | "unsupported"; reason: string };

export const resolveTargetResult = (
  selector: string,
  initialDocument: Document = document
): TargetResolution => {
  const tokens = selector.split(/(>>>|>>iframe>>)/).map((value) => value.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.length % 2 === 0) {
    return { status: "invalid", reason: "malformed selector" };
  }
  let root: Document | ShadowRoot = initialDocument;
  let current: Element | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (index % 2 === 0) {
      let matches: NodeListOf<Element>;
      try { matches = root.querySelectorAll(token); }
      catch { return { status: "invalid", reason: `invalid CSS segment: ${token}` }; }
      if (matches.length === 0) return { status: "missing", reason: `missing segment: ${token}` };
      if (matches.length > 1) return { status: "ambiguous", reason: `ambiguous segment: ${token}` };
      current = matches[0]!;
      continue;
    }
    if (token === ">>>") {
      if (!current?.shadowRoot) return { status: "unsupported", reason: "closed or missing shadow root" };
      root = current.shadowRoot;
      continue;
    }
    if (token !== ">>iframe>>" || current?.tagName.toLowerCase() !== "iframe") {
      return { status: "invalid", reason: "invalid realm boundary" };
    }
    try {
      const frameDocument = (current as HTMLIFrameElement).contentDocument;
      if (!frameDocument) {
        return { status: "unsupported", reason: "cross-origin or unavailable iframe" };
      }
      root = frameDocument;
    } catch {
      return { status: "unsupported", reason: "cross-origin iframe" };
    }
  }
  return current
    ? { status: "resolved", element: current }
    : { status: "missing", reason: "selector resolved nothing" };
};

export const resolveTarget = (selector: string): Element | null => {
  const result = resolveTargetResult(selector);
  return result.status === "resolved" ? result.element : null;
};

export const targetBounds = (element: Element): AgentFeedbackRect => boundsOf(element);

let frozen = false;
export const setInspectionFrozen = (active: boolean, elements: Element[] = []): void => {
  if (active === frozen) return;
  if (active) freeze(elements.length ? elements : undefined);
  else unfreeze();
  frozen = active;
};

const samplePoints = (rect: AgentFeedbackRect): Array<{ x: number; y: number }> => {
  const columns = Math.min(8, Math.max(2, Math.ceil(rect.width / 120)));
  const rows = Math.min(8, Math.max(2, Math.ceil(rect.height / 120)));
  const points = [
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    { x: rect.x + 2, y: rect.y + 2 },
    { x: rect.x + rect.width - 2, y: rect.y + 2 },
    { x: rect.x + 2, y: rect.y + rect.height - 2 },
    { x: rect.x + rect.width - 2, y: rect.y + rect.height - 2 },
  ];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push({
        x: rect.x + ((column + 0.5) * rect.width) / columns,
        y: rect.y + ((row + 0.5) * rect.height) / rows,
      });
    }
  }
  return points;
};

export function sampleRegionTargets(rect: AgentFeedbackRect): Element[] {
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const addCandidate = (element: Element): boolean => {
    if (seen.has(element)) return false;
    seen.add(element);
    candidates.push(element);
    return candidates.length >= MAX_REGION_CANDIDATES;
  };
  for (const point of samplePoints(rect)) {
    const elements = getElementsAtPoint(point.x, point.y, { filter: isRegionCandidate });
    if (elements.length === 0) {
      const element = document.elementFromPoint?.(point.x, point.y);
      if (element && isRegionCandidate(element) && addCandidate(element)) break;
    }
    for (const element of elements) {
      if (addCandidate(element)) break;
    }
    if (candidates.length >= MAX_REGION_CANDIDATES) break;
  }
  return pruneRegionTargets(candidates).slice(0, MAX_REGION_TARGETS);
}

const directText = (element: Element): string =>
  Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const semanticScore = (element: Element): number => {
  const tag = element.tagName.toLowerCase();
  const interactive = ["button", "a", "input", "select", "textarea", "summary"].includes(tag)
    || element.hasAttribute("role") || element.hasAttribute("tabindex");
  const named = ["aria-label", "aria-labelledby", "alt", "title"].some((name) => !!element.getAttribute(name)?.trim());
  return (interactive ? 8 : 0) + (named ? 4 : 0) + (element.id ? 2 : 0) + (directText(element) ? 1 : 0);
};

const composedParent = (element: Element): Element | null => {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return "host" in root ? (root as ShadowRoot).host : null;
};

const isAncestor = (ancestor: Element, descendant: Element): boolean => {
  for (let current = composedParent(descendant); current; current = composedParent(current)) {
    if (current === ancestor) return true;
  }
  return false;
};

export function pruneRegionTargets(candidates: readonly Element[]): Element[] {
  const indexed = candidates.map((element, index) => ({ element, index, score: semanticScore(element) }));
  const kept = indexed.filter((candidate) => !indexed.some((other) => {
    if (other === candidate) return false;
    if (isAncestor(candidate.element, other.element)) {
      return other.score > candidate.score || (other.score === candidate.score && other.index < candidate.index);
    }
    if (isAncestor(other.element, candidate.element)) {
      return other.score > candidate.score;
    }
    return false;
  }));
  return kept
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ element }) => element);
}

export const disposeInspectionEngine = (): void => {
  if (frozen) setInspectionFrozen(false);
  disposeBaselineStyles();
};
