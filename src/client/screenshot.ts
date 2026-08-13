export const MAX_SCREENSHOT_WIDTH = 1600;
export const MAX_SCREENSHOT_HEIGHT = 1200;

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
const SECRET = /(?:^|[-_.])(?:token|secret|password|authorization|cookie|api[-_.]?key)(?:$|[-_.])/i;

export type ScreenshotRect = { x: number; y: number; width: number; height: number };
export type CapturedScreenshot = {
  png: string;
  width: number;
  height: number;
  durationMs: number;
  bestEffort: true;
};

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

const sanitize = (source: Element, clone: Element): void => {
  for (const attribute of Array.from(clone.attributes)) {
    if (SECRET.test(attribute.name)) clone.removeAttribute(attribute.name);
  }
  inlineScreenshotStyle(source, clone);
  if (!MEDIA.has(source.tagName)) return;
  const rect = source.getBoundingClientRect();
  for (const name of ["src", "srcset", "poster", "data"]) clone.removeAttribute(name);
  clone.setAttribute("data-agent-feedback-media-placeholder", source.tagName.toLowerCase());
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
  clone.querySelector("#agent-feedback-root")?.remove();
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
  const timer = window.setTimeout(() => done(null), 5_000);
  image.onload = () => done(image);
  image.onerror = () => done(null);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
});

/** Best-effort structural viewport evidence; it deliberately does not claim pixel parity. */
export async function captureViewportPng(
  overlays: readonly ScreenshotRect[] = []
): Promise<CapturedScreenshot | null> {
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
    const image = await imageFromSvg(svg);
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.save();
    context.drawImage(image, 0, 0, width, height);
    context.scale(scale, scale);
    context.fillStyle = "#6366f122";
    context.strokeStyle = "#6366f1";
    context.lineWidth = 2 / scale;
    for (const rect of overlays) {
      context.fillRect(rect.x - scrollX, rect.y - scrollY, rect.width, rect.height);
      context.strokeRect(rect.x - scrollX, rect.y - scrollY, rect.width, rect.height);
    }
    context.restore();
    return {
      png: canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""),
      width,
      height,
      durationMs: performance.now() - started,
      bestEffort: true,
    };
  } catch {
    return null;
  }
}
