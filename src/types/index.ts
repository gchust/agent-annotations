export type AgentFeedbackJsonPrimitive = null | boolean | number | string;

export type AgentFeedbackJsonValue =
  | AgentFeedbackJsonPrimitive
  | AgentFeedbackJsonValue[]
  | AgentFeedbackJsonObject;

export type AgentFeedbackJsonObject = {
  [key: string]: AgentFeedbackJsonValue;
};

export type AgentFeedbackRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AgentFeedbackSourceLocation = {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  componentName: string | null;
};

export type AgentFeedbackInspection = {
  tagName: string;
  role: string;
  accessibleName: string;
  text: string;
  componentName: string | null;
  source: AgentFeedbackSourceLocation | null;
  sourceStack: AgentFeedbackSourceLocation[];
  htmlPreview: string;
  styleText: string;
  attributes: Record<string, string>;
};

export type AgentFeedbackTarget = {
  selector: string;
  bounds: AgentFeedbackRect;
  inspection: AgentFeedbackInspection;
};

export type AgentFeedbackRegion = AgentFeedbackRect & {
  coordinateSpace: "document";
};

export type AgentFeedbackPageContext = {
  url: string;
  routeKey: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
};

export type AgentFeedbackEvidenceReference = {
  kind: "screenshot" | "attachment";
  ref: string;
  mediaType?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
};

export type AgentFeedbackCompletionEvidence = {
  verified: boolean;
  summary: string;
  source: string;
  completedAt: string;
};

export type AgentFeedbackExtensionData = Record<
  string,
  AgentFeedbackJsonObject
>;

export type AgentFeedbackAnnotation = {
  annotationId: string;
  kind: "element" | "multi" | "region";
  comment: string;
  status: "open" | "completed";
  createdAt: string;
  completedAt?: string;
  completionEvidence?: AgentFeedbackCompletionEvidence;
  pageContext: AgentFeedbackPageContext;
  targets?: AgentFeedbackTarget[];
  region?: AgentFeedbackRegion;
  evidence?: AgentFeedbackEvidenceReference[];
  extensions: AgentFeedbackExtensionData;
};

export type AgentFeedbackTask = {
  schema: "agent-feedback.task.v1";
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  status: "active" | "completed";
  createdAt: string;
  updatedAt: string;
  annotations: AgentFeedbackAnnotation[];
};

export type AgentFeedbackValidationIssue = {
  path: string;
  code:
    | "invalid_type"
    | "invalid_value"
    | "unknown_field"
    | "limit_exceeded"
    | "non_json_value";
  message: string;
};

export type AgentFeedbackValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: AgentFeedbackValidationIssue };

export type CreateAgentFeedbackTaskInput = {
  taskId: string;
  createdAt: string;
  annotations?: AgentFeedbackAnnotation[];
};

export type AgentFeedbackMutationOperation =
  | { op: "add"; annotation: AgentFeedbackAnnotation }
  | { op: "update"; annotationId: string; comment: string }
  | {
      op: "setExtension";
      annotationId: string;
      extensionId: string;
      data: AgentFeedbackJsonObject;
    }
  | {
      op: "complete";
      annotationId: string;
      evidence?: Omit<AgentFeedbackCompletionEvidence, "completedAt">;
    }
  | { op: "reopen"; annotationId: string }
  | { op: "remove"; annotationId: string }
  | { op: "removeCompleted" };

export type AgentFeedbackMutationRequest = {
  taskId: string;
  expectedRevision: number;
  operations: AgentFeedbackMutationOperation[];
};

export type AgentFeedbackMutationError =
  | "invalid_task"
  | "invalid_operation"
  | "task_id_mismatch"
  | "annotation_not_found"
  | "duplicate_annotation"
  | "annotation_limit"
  | "invalid_annotation"
  | "invalid_extension";

export type AgentFeedbackMutationResult =
  | { ok: true; task: AgentFeedbackTask }
  | { ok: false; error: AgentFeedbackMutationError }
  | {
      ok: false;
      error: "revision_conflict";
      expectedRevision: number;
      actualRevision: number;
      task: AgentFeedbackTask;
    };

export type AgentFeedbackAnnotationFilter = "open" | "all";

export type AgentFeedbackFormatOptions = {
  format?: "markdown" | "json";
  annotations?: AgentFeedbackAnnotationFilter;
};

export type AgentFeedbackRedactionManifest = {
  droppedKeys: string[];
  redactedValues: number;
  truncatedValues: number;
};

export type AgentFeedbackExtensionRedactor = {
  extensionId: string;
  redact(
    data: AgentFeedbackJsonObject,
    context: { annotationId: string; extensionId: string }
  ): AgentFeedbackJsonObject | null;
};

export type AgentFeedbackRedactionResult = {
  task: AgentFeedbackTask;
  manifest: AgentFeedbackRedactionManifest;
};

export type AgentFeedbackSelectionState<T> = {
  targets: T[];
  region?: AgentFeedbackRect;
};

export type AgentFeedbackAnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type AgentFeedbackViewport = { width: number; height: number };

export type AgentFeedbackPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export type AgentFeedbackShortcutDefinition = {
  id: string;
  key: string;
  code?: string;
  primary: boolean;
  alt: boolean;
  shift: boolean;
};

export type AgentFeedbackShortcutInput = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  editable?: boolean;
};

export type AgentFeedbackPlatform = "mac" | "other";
