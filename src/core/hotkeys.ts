import type {
  AgentFeedbackPlatform,
  AgentFeedbackShortcutDefinition,
  AgentFeedbackShortcutInput,
} from "../types/index.js";

export const AGENT_FEEDBACK_SHORTCUTS = [
  { id: "pick", key: "P", code: "KeyP", primary: true, alt: true, shift: false },
  { id: "multi", key: "M", code: "KeyM", primary: true, alt: true, shift: false },
  { id: "area", key: "A", code: "KeyA", primary: true, alt: true, shift: false },
  { id: "copy", key: "C", code: "KeyC", primary: true, alt: true, shift: false },
  { id: "visibility", key: "V", code: "KeyV", primary: true, alt: true, shift: false },
  { id: "list", key: "L", code: "KeyL", primary: true, alt: true, shift: false },
  { id: "help", key: "/", code: "Slash", primary: false, alt: false, shift: true },
  { id: "toggle", key: "K", code: "KeyK", primary: true, alt: true, shift: false },
] as const satisfies readonly AgentFeedbackShortcutDefinition[];

export function formatAgentFeedbackShortcut(
  shortcut: AgentFeedbackShortcutDefinition,
  platform: AgentFeedbackPlatform
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

export function matchesAgentFeedbackShortcut(
  shortcut: AgentFeedbackShortcutDefinition,
  input: AgentFeedbackShortcutInput,
  platform: AgentFeedbackPlatform
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
