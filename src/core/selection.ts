import type {
  AgentAnnotationsRect,
  AgentAnnotationsRegion,
  AgentAnnotationsSelectionState,
} from "../types/index.js";
import { MAX_TARGETS_PER_ANNOTATION } from "./schema.js";

export const emptyAgentAnnotationsSelection = <T>(): AgentAnnotationsSelectionState<T> => ({
  targets: [],
});

export const replaceAgentAnnotationsSelection = <T>(
  target: T
): AgentAnnotationsSelectionState<T> => ({ targets: [target] });

export function toggleAgentAnnotationsSelection<T>(
  state: AgentAnnotationsSelectionState<T>,
  target: T,
  equals: (left: T, right: T) => boolean = Object.is
): AgentAnnotationsSelectionState<T> {
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

export function normalizeAgentAnnotationsRegion(
  raw: AgentAnnotationsRect,
  viewport: { width: number; height: number }
): AgentAnnotationsRect {
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

export function toAgentAnnotationsDocumentRegion(
  rect: AgentAnnotationsRect,
  scroll: { x: number; y: number }
): AgentAnnotationsRegion {
  return {
    coordinateSpace: "document",
    x: Math.round(rect.x + scroll.x),
    y: Math.round(rect.y + scroll.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
