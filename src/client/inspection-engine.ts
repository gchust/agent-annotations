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
  AgentAnnotationsInspection,
  AgentAnnotationsRect,
  AgentAnnotationsSourceLocation,
  AgentAnnotationsTarget,
  HostIntegration,
} from "../types/index.js";

const IGNORE = "[data-react-grab-ignore]";
const ROOTS = new Set(["html", "body"]);
const MAX_REGION_TARGETS = 50;
const MAX_REGION_CANDIDATES = 200;
export const REGION_SAMPLE_LIMIT = 69;
export const REGION_CANDIDATE_LIMIT = MAX_REGION_CANDIDATES;
export const REGION_TARGET_LIMIT = MAX_REGION_TARGETS;
// Reserved prefix for HostIntegration.identity() fields persisted inside the
// target inspection attributes; plain id/role/aria-label keys stay unprefixed.
export const HOST_IDENTITY_PREFIX = "host:";
// The persisted key (prefix included) must fit the schema's 100-character
// attribute key limit; values mirror the 500-character attribute value limit.
const HOST_IDENTITY_KEY_LIMIT = 100 - HOST_IDENTITY_PREFIX.length;
const HOST_IDENTITY_VALUE_LIMIT = 500;

// Single normalization path for persisted host identity evidence. Capture and
// restore MUST use exactly the same rules, otherwise a legal identity (with
// surrounding whitespace, repeated whitespace, or overlong content) would
// mismatch immediately after saving. Entries that normalize to empty are
// skipped deterministically; normalized-key collisions keep the first entry.
const normalizeHostIdentityEntry = (
  key: string,
  value: string
): { key: string; value: string } | null => {
  const normalizedKey = text(key, HOST_IDENTITY_KEY_LIMIT);
  const normalizedValue = text(value, HOST_IDENTITY_VALUE_LIMIT);
  if (!normalizedKey || !normalizedValue) return null;
  return { key: `${HOST_IDENTITY_PREFIX}${normalizedKey}`, value: normalizedValue };
};

const addHostIdentityEntries = (
  entries: Record<string, string>,
  identity: Record<string, string> | undefined
): void => {
  if (!identity) return;
  for (const [key, value] of Object.entries(identity)) {
    if (Object.keys(entries).length >= 50) break;
    const normalized = normalizeHostIdentityEntry(key, value);
    if (!normalized || normalized.key in entries) continue;
    entries[normalized.key] = normalized.value;
  }
};

const isCandidate = (element: Element): boolean =>
  element.isConnected &&
  !ROOTS.has(element.tagName.toLowerCase()) &&
  element.closest(IGNORE) === null &&
  isElementGrabbable(element);

const isRegionCandidate = (element: Element): boolean =>
  element.isConnected &&
  !ROOTS.has(element.tagName.toLowerCase()) &&
  element.closest(IGNORE) === null;

const boundsOf = (element: Element): AgentAnnotationsRect => {
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
}): AgentAnnotationsSourceLocation | null => {
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
  const normalizedId = text(element.id, 500);
  if (normalizedId) entries.id = normalizedId;
  const role = roleOf(element);
  const accessibleName = nameOf(element);
  if (role) entries.role = role;
  if (accessibleName) entries["aria-label"] = accessibleName;
  addHostIdentityEntries(entries, host?.identity?.(element));
  return entries;
};

const childSegment = (element: Element): string => {
  const parent = element.parentElement;
  const index = parent ? Array.from(parent.children).indexOf(element) + 1 : 1;
  return `${element.tagName.toLowerCase()}:nth-child(${index})`;
};

const exactLocalSelector = (element: Element): string => {
  const root = element.getRootNode() as Document | ShadowRoot;
  const segments: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    segments.unshift(childSegment(current));
    const selector = segments.join(" > ");
    const matches = root.querySelectorAll(selector);
    if (matches.length === 1 && matches[0] === element) return selector;
  }
  throw new Error("Could not create an exact selector for the selected element");
};

const exactStructuralSelector = (element: Element): string => {
  const local = exactLocalSelector(element);
  const root = element.getRootNode();
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in root) {
    return `${exactStructuralSelector((root as ShadowRoot).host)} >>> ${local}`;
  }
  const frame = element.ownerDocument.defaultView?.frameElement;
  return frame ? `${exactStructuralSelector(frame)} >>iframe>> ${local}` : local;
};

const selectorForExactElement = (element: Element, selector: string): string => {
  const resolved = resolveTargetResult(selector);
  if (resolved.status === "resolved" && resolved.element === element) return selector;
  if (resolved.status === "resolved" && resolved.element.contains(element)) {
    const segments: string[] = [];
    for (let current: Element | null = element;
      current && current !== resolved.element;
      current = current.parentElement) {
      segments.unshift(childSegment(current));
    }
    const repaired = `${selector} > ${segments.join(" > ")}`;
    const repairResult = resolveTargetResult(repaired);
    if (repairResult.status === "resolved" && repairResult.element === element) return repaired;
  }
  const fallback = exactStructuralSelector(element);
  const fallbackResult = resolveTargetResult(fallback);
  if (fallbackResult.status === "resolved" && fallbackResult.element === element) return fallback;
  throw new Error("React Grab selector did not resolve the selected element");
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
): Promise<AgentAnnotationsTarget> {
  const context = await getElementContext(element);
  const upstreamSelector = getElementSelector(element);
  if (!upstreamSelector) throw new Error("React Grab returned an empty selector");
  const selector = selectorForExactElement(element, upstreamSelector);
  const sourceStack = context.stack
    .map((frame) => source(frame))
    .filter((frame): frame is AgentAnnotationsSourceLocation => frame !== null)
    .slice(0, 12);
  const inspection: AgentAnnotationsInspection = {
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
  | {
      status:
        | "missing"
        | "ambiguous"
        | "invalid"
        | "unsupported"
        | "identity_mismatch"
        | "identity_unverifiable";
      reason: string;
    };

export const resolveTargetResult = (
  selector: string,
  initialRoot: Document | ShadowRoot | Element = document
): TargetResolution => {
  const tokens = selector.split(/(>>>|>>iframe>>)/).map((value) => value.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.length % 2 === 0) {
    return { status: "invalid", reason: "malformed selector" };
  }
  let root: Document | ShadowRoot | Element = initialRoot;
  let current: Element | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (index % 2 === 0) {
      let matches: NodeListOf<Element>;
      try { matches = root.querySelectorAll(token); }
      catch { return { status: "invalid", reason: `invalid CSS segment: ${token}` }; }
      // An Element root can itself be a first-segment match (nodeType, not
      // instanceof: cross-realm documents have their own Element class). The
      // root and its descendants share one candidate count: exactly one wins,
      // more than one is ambiguous.
      const selfMatches = root.nodeType === 1 && (root as Element).matches?.(token) === true;
      const total = matches.length + (selfMatches ? 1 : 0);
      if (total === 0) return { status: "missing", reason: `missing segment: ${token}` };
      if (total > 1) return { status: "ambiguous", reason: `ambiguous segment: ${token}` };
      current = selfMatches ? (root as Element) : matches[0]!;
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

type TargetIdentityFailure = {
  status: "identity_mismatch" | "identity_unverifiable";
  reason: string;
};

const targetIdentityFailure = (
  element: Element,
  inspection: AgentAnnotationsInspection,
  host?: HostIntegration
): TargetIdentityFailure | null => {
  if (inspection.tagName && element.tagName.toLowerCase() !== inspection.tagName) {
    return { status: "identity_mismatch", reason: "element tag changed" };
  }

  const attributes = inspection.attributes ?? {};
  const persistedId = attributes.id;
  if (persistedId !== undefined && text(element.id, 500) !== persistedId) {
    return { status: "identity_mismatch", reason: "element id changed" };
  }

  const hostKeys = Object.keys(attributes).filter((key) =>
    key.startsWith(HOST_IDENTITY_PREFIX)
  );
  if (hostKeys.length > 0) {
    const live: Record<string, string> = {};
    addHostIdentityEntries(live, host?.identity?.(element));
    for (const key of hostKeys) {
      if (live[key] !== attributes[key]) {
        return { status: "identity_mismatch", reason: "host identity changed" };
      }
    }
  }

  if (persistedId === undefined && hostKeys.length === 0) {
    const persistedRole = attributes.role ?? (inspection.role || undefined);
    const persistedName =
      attributes["aria-label"] ?? (inspection.accessibleName || undefined);
    if (!persistedRole && !persistedName) {
      return { status: "identity_unverifiable", reason: "no persisted identity evidence" };
    }
    if (persistedRole && roleOf(element) !== persistedRole) {
      return { status: "identity_mismatch", reason: "element role changed" };
    }
    if (persistedName && nameOf(element) !== persistedName) {
      return { status: "identity_mismatch", reason: "accessible name changed" };
    }
  }

  return null;
};

// Resolves a persisted target only when both the unique React Grab selector
// AND the persisted identity evidence match the live element:
//   selector (must be unique) → tagName → persisted id → persisted host:
//   identity fields → weak role + accessibleName (only when no strong
//   identity exists). A legacy React Grab ancestor-selector bug is recovered
//   only when exactly one descendant has the complete persisted identity.
//   Every other mismatch stays explicit.
export const resolvePersistedTarget = (
  target: AgentAnnotationsTarget,
  options: { appRoot: Document | ShadowRoot | Element; host?: HostIntegration }
): TargetResolution => {
  const selectorResult = resolveTargetResult(target.selector, options.appRoot);
  if (selectorResult.status !== "resolved") return selectorResult;
  const element = selectorResult.element;
  const inspection = target.inspection;
  const directFailure = targetIdentityFailure(element, inspection, options.host);
  if (!directFailure) return { status: "resolved", element };
  if (inspection.tagName) {
    const exactDescendants = Array.from(element.getElementsByTagName(inspection.tagName))
      .filter((candidate) => !targetIdentityFailure(candidate, inspection, options.host));
    if (exactDescendants.length === 1) {
      return { status: "resolved", element: exactDescendants[0]! };
    }
  }
  return directFailure;
};

export const targetBounds = (element: Element): AgentAnnotationsRect => boundsOf(element);

let frozen = false;
export const setInspectionFrozen = (active: boolean, elements: Element[] = []): void => {
  if (active === frozen) return;
  if (active) freeze(elements.length ? elements : undefined);
  else unfreeze();
  frozen = active;
};

const samplePoints = (rect: AgentAnnotationsRect): Array<{ x: number; y: number }> => {
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

export function sampleRegionTargets(rect: AgentAnnotationsRect): Element[] {
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
