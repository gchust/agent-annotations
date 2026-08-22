export * from "./conflict.js";
export * from "./format.js";
export * from "./handoff.js";
export * from "./hotkeys.js";
export * from "./ids.js";
export * from "./mutation.js";
export * from "./redact-mutation.js";
export * from "./placement.js";
export * from "./redaction.js";
export * from "./schema.js";
export * from "./selection.js";
export * from "./selectors.js";
export { TaskTransportProtocolError, TaskTransportValidationError } from "./transport.js";

// The pure type surface of /core: only the task-schema and core-API types
// are re-exported here (never `export type *`, which would pull browser and
// React extension types into a host-neutral entry).
export type {
  AgentAnnotation,
  AgentAnnotationFilter,
  AgentAnnotationsAnchorRect,
  AgentAnnotationsCompletionEvidence,
  AgentAnnotationsEvidenceReference,
  AgentAnnotationsExtensionData,
  AgentAnnotationsExtensionRedactor,
  AgentAnnotationsFormatOptions,
  AgentAnnotationsHandoffConfig,
  AgentAnnotationsInspection,
  AgentAnnotationsJsonObject,
  AgentAnnotationsJsonPrimitive,
  AgentAnnotationsJsonValue,
  AgentAnnotationsMutationError,
  AgentAnnotationsMutationOperation,
  AgentAnnotationsMutationRequest,
  AgentAnnotationsMutationResult,
  AgentAnnotationsPageContext,
  AgentAnnotationsPlacement,
  AgentAnnotationsPlatform,
  AgentAnnotationsRect,
  AgentAnnotationsRedactionManifest,
  AgentAnnotationsRedactionResult,
  AgentAnnotationsRegion,
  AgentAnnotationsSelectionState,
  AgentAnnotationsShortcutDefinition,
  AgentAnnotationsShortcutInput,
  AgentAnnotationsSourceLocation,
  AgentAnnotationsTarget,
  AgentAnnotationsTask,
  CreateAgentAnnotationsTaskInput,
  AgentAnnotationsToolbarShortcut,
  AgentAnnotationsValidationIssue,
  AgentAnnotationsValidationResult,
  AgentAnnotationsViewport,
} from "../types/index.js";
