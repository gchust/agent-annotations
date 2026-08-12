import type {
  AgentFeedbackAnchorRect,
  AgentFeedbackPlacement,
  AgentFeedbackViewport,
} from "../types/index.js";

export const AGENT_FEEDBACK_PLACEMENT_GAP = 8;
export const AGENT_FEEDBACK_PLACEMENT_MARGIN = 4;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function resolveAgentFeedbackPlacement(input: {
  trigger: AgentFeedbackAnchorRect;
  viewport: AgentFeedbackViewport;
  width: number;
  maxHeight: number;
  gap?: number;
  preferredSide?: "above" | "below";
  surfaceHeight?: number;
}): AgentFeedbackPlacement {
  const margin = AGENT_FEEDBACK_PLACEMENT_MARGIN;
  const gap = input.gap ?? AGENT_FEEDBACK_PLACEMENT_GAP;
  const width = Math.min(
    Math.max(0, input.width),
    Math.max(0, input.viewport.width - margin * 2)
  );
  const maxHeight = Math.min(
    Math.max(0, input.maxHeight),
    Math.max(0, input.viewport.height - margin * 2)
  );
  const height = Math.min(
    Math.max(0, input.surfaceHeight ?? maxHeight),
    maxHeight
  );
  let left = Math.round(input.trigger.left);
  if (left + width > input.viewport.width - margin) {
    left = Math.round(input.trigger.right - width);
  }
  left = clamp(left, margin, Math.max(margin, input.viewport.width - width - margin));
  const below = input.viewport.height - input.trigger.bottom - gap;
  const above = input.trigger.top - gap;
  const preferred = input.preferredSide ?? "below";
  const placeBelow =
    preferred === "below" ? below >= height || below >= above : above < height && below > above;
  const top = placeBelow
    ? Math.round(input.trigger.bottom + gap)
    : Math.round(input.trigger.top - gap - height);
  return {
    left,
    top: clamp(
      top,
      margin,
      Math.max(margin, input.viewport.height - height - margin)
    ),
    width,
    maxHeight,
  };
}

export const agentFeedbackAnchorRect = (rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): AgentFeedbackAnchorRect => ({
  ...rect,
  right: rect.left + rect.width,
  bottom: rect.top + rect.height,
});
