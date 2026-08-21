/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { localeMessages, MESSAGES } from "../../src/client/messages.js";

describe("builtin message dictionary", () => {
  it("provides complete en-US and zh-CN text for every key", () => {
    const keys = Object.keys(MESSAGES);
    expect(keys.length).toBeGreaterThanOrEqual(30);
    const table = MESSAGES as Record<string, Record<"en-US" | "zh-CN", string>>;
    for (const key of keys) {
      const entry = table[key]!;
      expect(typeof entry["en-US"]).toBe("string");
      expect(typeof entry["zh-CN"]).toBe("string");
      expect(entry["en-US"].length).toBeGreaterThan(0);
      expect(entry["zh-CN"].length).toBeGreaterThan(0);
      expect(entry["en-US"]).not.toBe(entry["zh-CN"]);
    }
  });

  it("covers every contract-mandated surface with both locales", () => {
    const required = [
      "Pick", "Multi", "Area", "Copy", "Markers", "Shortcut help", "Annotations",
      "Collapse toolbar", "Expand toolbar", "Drag toolbar", "Annotation list",
      "Annotation composer", "Annotation comment", "Describe the requested change",
      "Cancel", "Save annotation", "Pick annotation", "Multi annotation",
      "Annotation saved", "Save failed", "Finish", "Complete selection",
      "Annotation editor", "Save comment", "Complete", "Reopen", "Delete", "Close",
      "Comment saved", "Capture screenshot", "Screenshot captured", "Screenshot failed",
      "Manual copy fallback", "Copied open annotations", "Panel failed to render",
      "Open", "All", "open", "completed", "Remove completed",
      "Confirm remove completed one", "Confirm remove completed",
      "unresolved", "identity mismatch", "identity unverifiable", "iframe unsupported",
      "targets", "openAnnotations", "evidence",
      "Route", "element", "multi", "region",
    ];
    const table = MESSAGES as Record<string, unknown>;
    for (const key of required) {
      expect(table[key]).toBeDefined();
    }
  });

  it("resolves localeMessages with explicit fallbacks", () => {
    const en = localeMessages("en-US");
    const zh = localeMessages("zh-CN");
    const zhBase = localeMessages("zh");
    const other = localeMessages("fr");
    expect(en["Pick"]).toBe("Pick");
    expect(zh["Pick"]).toBe("拾取");
    expect(zhBase["Pick"]).toBe("拾取");
    // List kinds are fully localized, including the lowercase multi kind.
    expect(zh["element"]).toBe("元素");
    expect(zh["multi"]).toBe("多选");
    expect(zh["region"]).toBe("区域");
    expect(zh["Route"]).toBe("路由");
    expect(other["Pick"]).toBe("Pick");
    expect(zh["Drag toolbar"]).toBe("拖动工具栏");
    expect(Object.keys(zh)).toEqual(Object.keys(en));
  });

  it("keeps every localized()/translate() literal key inside the dictionary (message-list audit)", () => {
    const sources = [
      "src/client/runtime.ts",
      "src/client/builtin-extension.ts",
    ];
    const keys = new Set(Object.keys(MESSAGES));
    let auditFailures = 0;
    for (const file of sources) {
      const source = readFileSync(path.resolve(file), "utf8");
      const pattern = /\b(?:localized|translate\(studio)\("([^"]+)"(?:",\s*\{)?/g;
      for (const match of source.matchAll(pattern)) {
        const key = match[1]!;
        if (!keys.has(key)) {
          auditFailures += 1;
          // eslint-disable-next-line no-console
          console.error(`[message audit] ${file}: missing key ${JSON.stringify(key)}`);
        }
      }
    }
    expect(auditFailures).toBe(0);
  });
});
