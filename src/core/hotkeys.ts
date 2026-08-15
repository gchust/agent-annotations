import type {
  AgentAnnotationsPlatform,
  AgentAnnotationsShortcutDefinition,
  AgentAnnotationsShortcutInput,
} from "../types/index.js";

export const AGENT_ANNOTATIONS_SHORTCUTS = [
  { id: "pick", key: "P", code: "KeyP", primary: true, alt: true, shift: false },
  { id: "multi", key: "M", code: "KeyM", primary: true, alt: true, shift: false },
  { id: "area", key: "A", code: "KeyA", primary: true, alt: true, shift: false },
  { id: "copy", key: "C", code: "KeyC", primary: true, alt: true, shift: false },
  { id: "visibility", key: "V", code: "KeyV", primary: true, alt: true, shift: false },
  { id: "list", key: "L", code: "KeyL", primary: true, alt: true, shift: false },
  { id: "help", key: "/", code: "Slash", primary: false, alt: false, shift: true },
  { id: "toggle", key: "K", code: "KeyK", primary: true, alt: true, shift: false },
] as const satisfies readonly AgentAnnotationsShortcutDefinition[];

export function formatAgentAnnotationsShortcut(
  shortcut: AgentAnnotationsShortcutDefinition,
  platform: AgentAnnotationsPlatform
): string {
  return [
    shortcut.primary ? (platform === "mac" ? "⌘" : "Ctrl") : null,
    shortcut.alt ? (platform === "mac" ? "⌥" : "Alt") : null,
    shortcut.shift ? (platform === "mac" ? "⇧" : "Shift") : null,
    shortcut.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join(platform === "mac" ? "" : "+");
}

export function matchesAgentAnnotationsShortcut(
  shortcut: AgentAnnotationsShortcutDefinition,
  input: AgentAnnotationsShortcutInput,
  platform: AgentAnnotationsPlatform
): boolean {
  if (input.editable || input.repeat || input.isComposing) return false;
  const primary = platform === "mac" ? input.metaKey === true : input.ctrlKey === true;
  const extraPrimary = platform === "mac" ? input.ctrlKey === true : input.metaKey === true;
  if (primary !== shortcut.primary || extraPrimary) return false;
  if ((input.altKey === true) !== shortcut.alt) return false;
  if ((input.shiftKey === true) !== shortcut.shift) return false;
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  if (key === shortcut.key.toUpperCase()) return true;
  return shortcut.code !== undefined && input.code === shortcut.code;
}
