export const MAX_SCREENSHOT_WIDTH = 1600;
export const MAX_SCREENSHOT_HEIGHT = 1200;
export const MAX_SCREENSHOT_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const STYLE_PROPERTIES = [
  "display", "position", "visibility", "opacity", "box-sizing", "width", "height",
  "min-width", "min-height", "max-width", "max-height", "overflow", "overflow-x",
  "overflow-y", "color", "background-color", "background-image", "font-family",
  "font-size", "font-weight", "font-style", "line-height", "text-align", "white-space",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top",
  "margin-right", "margin-bottom", "margin-left", "border-top-width",
  "border-right-width", "border-bottom-width", "border-left-width", "border-top-style",
  "border-right-style", "border-bottom-style", "border-left-style", "border-top-color",
  "border-right-color", "border-bottom-color", "border-left-color", "border-radius",
  "flex-direction", "flex-wrap", "align-items", "justify-content", "gap", "grid-template-columns",
  "grid-template-rows", "transform", "transform-origin", "text-decoration-line", "vertical-align",
] as const;
const MEDIA = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "AUDIO", "OBJECT", "EMBED"]);
const FORM_CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const SECRET = /(?:^|[-_.])(?:token|secret|password|authorization|cookie|api[-_.]?key)(?:$|[-_.])/i;

export type ScreenshotRect = { x: number; y: number; width: number; height: number };
export type CapturedScreenshot = {
  png: string;
  width: number;
  height: number;
  durationMs: number;
  bestEffort: true;
};
export type PreparedViewportSnapshot = Readonly<{
  svg: string;
  width: number;
  height: number;
  scale: number;
  overlays: readonly Readonly<ScreenshotRect>[];
  startedAt: number;
}>;

export const computeScreenshotScale = (
  width: number,
  height: number,
  maxWidth = MAX_SCREENSHOT_WIDTH,
  maxHeight = MAX_SCREENSHOT_HEIGHT
): number => width > 0 && height > 0
  ? Math.min(1, maxWidth / width, maxHeight / height)
  : 1;

const computedStyle = (element: Element): CSSStyleDeclaration | null =>
  element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;

export function inlineScreenshotStyle(source: Element, clone: Element): void {
  const computed = computedStyle(source);
  if (!computed) return;
  const style = clone.getAttribute("style") ? `${clone.getAttribute("style")};` : "";
  const declarations = STYLE_PROPERTIES.flatMap((property) => {
    let value = computed.getPropertyValue(property).trim();
    if (!value) return [];
    if (property === "background-image" && /url\s*\(/i.test(value)) value = "none";
    return [`${property}:${value}`];
  });
  clone.setAttribute("style", `${style}${declarations.join(";")}`);
}

const sanitizeFormState = (source: Element, clone: Element): void => {
  if (source.tagName === "INPUT") {
    const input = clone as HTMLInputElement;
    const type = (source as HTMLInputElement).type;
    input.removeAttribute("value");
    input.removeAttribute("checked");
    input.checked = false;
    input.value = type === "password" ? "••••••" : "";
  } else if (source.tagName === "TEXTAREA") {
    const textarea = clone as HTMLTextAreaElement;
    textarea.value = "";
    textarea.textContent = "";
  } else if (source.tagName === "SELECT") {
    const select = clone as HTMLSelectElement;
    for (const option of select.querySelectorAll("option[selected]")) {
      option.removeAttribute("selected");
    }
    select.value = "";
  }
  if ((source as HTMLElement).isContentEditable || source.hasAttribute("contenteditable")) {
    clone.textContent = "";
  }
};

const sanitize = (source: Element, clone: Element): void => {
  for (const attribute of Array.from(clone.attributes)) {
    if (SECRET.test(attribute.name)) clone.removeAttribute(attribute.name);
  }
  inlineScreenshotStyle(source, clone);
  if (FORM_CONTROLS.has(source.tagName) || (source as HTMLElement).isContentEditable || source.hasAttribute("contenteditable")) {
    sanitizeFormState(source, clone);
  }
  if (!MEDIA.has(source.tagName)) return;
  const rect = source.getBoundingClientRect();
  for (const name of ["src", "srcset", "poster", "data"]) clone.removeAttribute(name);
  clone.setAttribute("data-agent-annotations-media-placeholder", source.tagName.toLowerCase());
  clone.setAttribute(
    "style",
    `${clone.getAttribute("style") ?? ""};display:inline-block;width:${rect.width}px;height:${rect.height}px;background:#e5e7eb`
  );
  clone.replaceChildren();
};

/** Clone and style in source/clone lockstep before media is changed. */
export function cloneScreenshotRoot(root: Element): Element {
  const clone = root.cloneNode(true) as Element;
  const sources: Element[] = [root];
  const clones: Element[] = [clone];
  const sourceWalker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const cloneWalker = root.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  while (sourceWalker.nextNode() && cloneWalker.nextNode()) {
    sources.push(sourceWalker.currentNode as Element);
    clones.push(cloneWalker.currentNode as Element);
  }
  for (let index = 0; index < sources.length; index += 1) sanitize(sources[index]!, clones[index]!);
  clone.querySelector("#agent-annotations-root")?.remove();
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  return clone;
}

export function buildScreenshotSvg(
  body: string,
  viewportWidth: number,
  viewportHeight: number,
  outputWidth: number,
  outputHeight: number,
  scrollX: number,
  scrollY: number
): string {
  const translated = `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${viewportWidth}px;height:${viewportHeight}px;overflow:hidden"><div style="position:absolute;left:${-scrollX}px;top:${-scrollY}px">${body}</div></div>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${viewportWidth} ${viewportHeight}"><foreignObject width="${viewportWidth}" height="${viewportHeight}">${translated}</foreignObject></svg>`;
}

const imageFromSvg = (svg: string): Promise<HTMLImageElement | null> => new Promise((resolve) => {
  const image = new Image();
  let settled = false;
  const done = (value: HTMLImageElement | null) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    resolve(value);
  };
  const timer = window.setTimeout(() => done(null), 10_000);
  image.onload = () => {
    if (typeof image.decode !== "function") return done(image);
    image.decode().then(() => done(image), () => done(null));
  };
  image.onerror = () => done(null);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
});

/** Freeze-faithful, sanitized snapshot of the live page. */
export function prepareViewportSnapshot(
  overlays: readonly ScreenshotRect[] = []
): PreparedViewportSnapshot | null {
  const started = performance.now();
  try {
    const viewportWidth = Math.max(1, innerWidth);
    const viewportHeight = Math.max(1, innerHeight);
    const scale = computeScreenshotScale(viewportWidth, viewportHeight);
    const width = Math.round(viewportWidth * scale);
    const height = Math.round(viewportHeight * scale);
    const clone = cloneScreenshotRoot(document.documentElement);
    const svg = buildScreenshotSvg(
      new XMLSerializer().serializeToString(clone),
      viewportWidth,
      viewportHeight,
      width,
      height,
      scrollX,
      scrollY
    );
    if (new TextEncoder().encode(svg).byteLength > MAX_SCREENSHOT_SNAPSHOT_BYTES) return null;
    return Object.freeze({
      svg,
      width,
      height,
      scale,
      overlays: Object.freeze(overlays.map((rect) => Object.freeze({ ...rect }))),
      startedAt: started,
    });
  } catch {
    return null;
  }
}

/** Render a prepared snapshot without reading the live page DOM. */
export async function renderPreparedSnapshotPng(
  snapshot: PreparedViewportSnapshot
): Promise<CapturedScreenshot | null> {
  try {
    const image = await imageFromSvg(snapshot.svg);
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.save();
    context.drawImage(image, 0, 0, snapshot.width, snapshot.height);
    context.scale(snapshot.scale, snapshot.scale);
    context.fillStyle = "#6366f122";
    context.strokeStyle = "#6366f1";
    context.lineWidth = 2 / snapshot.scale;
    // Overlays are top-level viewport coordinates; the SVG page content is
    // already translated by -scrollX/-scrollY, so no second scroll subtraction.
    for (const rect of snapshot.overlays) {
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
    context.restore();
    return {
      png: canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""),
      width: snapshot.width,
      height: snapshot.height,
      durationMs: performance.now() - snapshot.startedAt,
      bestEffort: true,
    };
  } catch {
    return null;
  }
}

/** Best-effort structural viewport evidence; it deliberately does not claim pixel parity. */
export async function captureViewportPng(
  overlays: readonly ScreenshotRect[] = []
): Promise<CapturedScreenshot | null> {
  const snapshot = prepareViewportSnapshot(overlays);
  return snapshot ? renderPreparedSnapshotPng(snapshot) : null;
}
