import type {
  AgentFeedbackRect,
  AgentFeedbackRegion,
  AgentFeedbackSelectionState,
} from "../types/index.js";
import { MAX_TARGETS_PER_ANNOTATION } from "./schema.js";

export const emptyAgentFeedbackSelection = <T>(): AgentFeedbackSelectionState<T> => ({
  targets: [],
});

export const replaceAgentFeedbackSelection = <T>(
  target: T
): AgentFeedbackSelectionState<T> => ({ targets: [target] });

export function toggleAgentFeedbackSelection<T>(
  state: AgentFeedbackSelectionState<T>,
  target: T,
  equals: (left: T, right: T) => boolean = Object.is
): AgentFeedbackSelectionState<T> {
  const index = state.targets.findIndex((candidate) => equals(candidate, target));
  if (index !== -1) {
    return {
      ...state,
      targets: state.targets.filter((_, current) => current !== index),
    };
  }
  return state.targets.length >= MAX_TARGETS_PER_ANNOTATION
    ? state
    : { ...state, targets: [...state.targets, target] };
}

export function normalizeAgentFeedbackRegion(
  raw: AgentFeedbackRect,
  viewport: { width: number; height: number }
): AgentFeedbackRect {
  const x = Math.min(Math.max(0, Math.round(raw.x)), Math.max(0, viewport.width));
  const y = Math.min(Math.max(0, Math.round(raw.y)), Math.max(0, viewport.height));
  return {
    x,
    y,
    width: Math.min(
      Math.max(0, Math.round(raw.width)),
      Math.max(0, viewport.width - x)
    ),
    height: Math.min(
      Math.max(0, Math.round(raw.height)),
      Math.max(0, viewport.height - y)
    ),
  };
}

export function toAgentFeedbackDocumentRegion(
  rect: AgentFeedbackRect,
  scroll: { x: number; y: number }
): AgentFeedbackRegion {
  return {
    coordinateSpace: "document",
    x: Math.round(rect.x + scroll.x),
    y: Math.round(rect.y + scroll.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
