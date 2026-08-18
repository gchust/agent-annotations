import { describe, expect, it } from "vitest";

import {
  AGENT_ANNOTATIONS_SHORTCUTS,
  formatAgentAnnotationsShortcut,
  matchesAgentAnnotationsShortcut,
} from "../../src/core/hotkeys.js";

describe("agent annotation hotkey registry", () => {
  it("lists features in the exact toolbar order with collapse separate at the end", () => {
    expect(AGENT_ANNOTATIONS_SHORTCUTS.map(({ id }) => id)).toEqual([
      "pick",
      "multi",
      "area",
      "copy",
      "visibility",
      "help",
      "list",
      "toggle",
    ]);
    const keys = AGENT_ANNOTATIONS_SHORTCUTS.map(({ key }) => key);
    expect(keys).toEqual(["P", "M", "A", "C", "V", "/", "L", "K"]);
  });

  it("formats shortcuts per platform", () => {
    const pick = AGENT_ANNOTATIONS_SHORTCUTS.find(({ id }) => id === "pick")!;
    const help = AGENT_ANNOTATIONS_SHORTCUTS.find(({ id }) => id === "help")!;
    expect(formatAgentAnnotationsShortcut(pick, "other")).toBe("Ctrl+Alt+P");
    expect(formatAgentAnnotationsShortcut(pick, "mac")).toBe("⌘⌥P");
    expect(formatAgentAnnotationsShortcut(help, "other")).toBe("Shift+/");
    expect(formatAgentAnnotationsShortcut(help, "mac")).toBe("⇧/");
  });

  it("matches by key and code across platforms", () => {
    const pick = AGENT_ANNOTATIONS_SHORTCUTS.find(({ id }) => id === "pick")!;
    const base = { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, editable: false };
    expect(matchesAgentAnnotationsShortcut(pick, { ...base, key: "p", ctrlKey: true, altKey: true }, "other")).toBe(true);
    expect(matchesAgentAnnotationsShortcut(pick, { ...base, code: "KeyP", ctrlKey: true, altKey: true }, "other")).toBe(true);
    expect(matchesAgentAnnotationsShortcut(pick, { ...base, key: "p", metaKey: true, altKey: true }, "mac")).toBe(true);
    expect(matchesAgentAnnotationsShortcut(pick, { ...base, key: "p", metaKey: true, altKey: true }, "other")).toBe(false);
    expect(matchesAgentAnnotationsShortcut(pick, { ...base, key: "p", ctrlKey: true, altKey: true, metaKey: true }, "other")).toBe(false);
    expect(matchesAgentAnnotationsShortcut(pick, { ...base, key: "p", ctrlKey: true }, "other")).toBe(false);
  });

  it("never fires while editing, repeating, or composing", () => {
    const copy = AGENT_ANNOTATIONS_SHORTCUTS.find(({ id }) => id === "copy")!;
    const base = { key: "c", code: "KeyC", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, repeat: false, isComposing: false, editable: false };
    expect(matchesAgentAnnotationsShortcut(copy, base, "other")).toBe(true);
    expect(matchesAgentAnnotationsShortcut(copy, { ...base, editable: true }, "other")).toBe(false);
    expect(matchesAgentAnnotationsShortcut(copy, { ...base, repeat: true }, "other")).toBe(false);
    expect(matchesAgentAnnotationsShortcut(copy, { ...base, isComposing: true }, "other")).toBe(false);
  });
});
