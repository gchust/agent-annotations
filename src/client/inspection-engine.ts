import {
  disposeBaselineStyles,
  getElementAtPoint,
  getElementBounds,
  getElementContext,
  getElementSelector,
  getElementsAtPoint,
  isElementGrabbable,
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

const isCandidate = (element: Element): boolean =>
  element.isConnected &&
  !ROOTS.has(element.tagName.toLowerCase()) &&
  element.closest(IGNORE) === null &&
  isElementGrabbable(element);

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

export const resolveTarget = (selector: string): Element | null => {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
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
  const result: Element[] = [];
  const seen = new Set<Element>();
  for (const point of samplePoints(rect)) {
    for (const element of getElementsAtPoint(point.x, point.y, { filter: isCandidate })) {
      if (seen.has(element)) continue;
      seen.add(element);
      result.push(element);
      if (result.length >= MAX_REGION_TARGETS) return result;
    }
  }
  return result;
}

export const disposeInspectionEngine = (): void => disposeBaselineStyles();
