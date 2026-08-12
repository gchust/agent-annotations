import type { AgentFeedbackClientExtension } from "../types/index.js";

export const agentFeedbackExtensionApiVersion = 1 as const;
export const defineClientExtension = <T extends AgentFeedbackClientExtension>(
  extension: T
): T => extension;
export type * from "../types/index.js";
