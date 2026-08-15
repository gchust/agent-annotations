export type AgentAnnotationsJsonPrimitive = null | boolean | number | string;

export type AgentAnnotationsJsonValue =
  | AgentAnnotationsJsonPrimitive
  | AgentAnnotationsJsonValue[]
  | AgentAnnotationsJsonObject;

export type AgentAnnotationsJsonObject = {
  [key: string]: AgentAnnotationsJsonValue;
};

export type AgentAnnotationsRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AgentAnnotationsSourceLocation = {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  componentName: string | null;
};

export type AgentAnnotationsInspection = {
  tagName: string;
  role: string;
  accessibleName: string;
  text: string;
  componentName: string | null;
  source: AgentAnnotationsSourceLocation | null;
  sourceStack: AgentAnnotationsSourceLocation[];
  htmlPreview: string;
  styleText: string;
  attributes: Record<string, string>;
};

export type AgentAnnotationsTarget = {
  selector: string;
  bounds: AgentAnnotationsRect;
  inspection: AgentAnnotationsInspection;
};

export type AgentAnnotationsRegion = AgentAnnotationsRect & {
  coordinateSpace: "document";
};

export type AgentAnnotationsPageContext = {
  url: string;
  routeKey: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
};

export type AgentAnnotationsEvidenceReference = {
  kind: "screenshot" | "attachment";
  ref: string;
  mediaType?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
};

export type AgentAnnotationsCompletionEvidence = {
  verified: boolean;
  summary: string;
  source: string;
  completedAt: string;
};

export type AgentAnnotationsExtensionData = Record<
  string,
  AgentAnnotationsJsonObject
>;

export type AgentAnnotation = {
  annotationId: string;
  kind: "element" | "multi" | "region";
  comment: string;
  status: "open" | "completed";
  createdAt: string;
  completedAt?: string;
  completionEvidence?: AgentAnnotationsCompletionEvidence;
  pageContext: AgentAnnotationsPageContext;
  targets?: AgentAnnotationsTarget[];
  region?: AgentAnnotationsRegion;
  evidence?: AgentAnnotationsEvidenceReference[];
  extensions: AgentAnnotationsExtensionData;
};

export type AgentAnnotationsTask = {
  schema: "agent-annotations.task.v1";
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  status: "active" | "completed";
  createdAt: string;
  updatedAt: string;
  annotations: AgentAnnotation[];
};

export type AgentAnnotationsValidationIssue = {
  path: string;
  code:
    | "invalid_type"
    | "invalid_value"
    | "unknown_field"
    | "limit_exceeded"
    | "non_json_value";
  message: string;
};

export type AgentAnnotationsValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: AgentAnnotationsValidationIssue };

export type CreateAgentAnnotationsTaskInput = {
  taskId: string;
  createdAt: string;
  annotations?: AgentAnnotation[];
};

export type AgentAnnotationsMutationOperation =
  | { op: "add"; annotation: AgentAnnotation }
  | { op: "update"; annotationId: string; comment: string }
  | {
      op: "setExtension";
      annotationId: string;
      extensionId: string;
      data: AgentAnnotationsJsonObject;
    }
  | {
      op: "complete";
      annotationId: string;
      evidence?: Omit<AgentAnnotationsCompletionEvidence, "completedAt">;
    }
  | {
      op: "addEvidence";
      annotationId: string;
      evidence: AgentAnnotationsEvidenceReference;
    }
  | { op: "reopen"; annotationId: string }
  | { op: "remove"; annotationId: string }
  | { op: "removeCompleted" };

export type AgentAnnotationsMutationRequest = {
  taskId: string;
  expectedRevision: number;
  operations: AgentAnnotationsMutationOperation[];
};

export type AgentAnnotationsMutationError =
  | "invalid_task"
  | "invalid_operation"
  | "task_id_mismatch"
  | "annotation_not_found"
  | "duplicate_annotation"
  | "annotation_limit"
  | "invalid_annotation"
  | "invalid_extension";

export type AgentAnnotationsMutationResult =
  | { ok: true; task: AgentAnnotationsTask }
  | { ok: false; error: AgentAnnotationsMutationError }
  | {
      ok: false;
      error: "revision_conflict";
      expectedRevision: number;
      actualRevision: number;
      task: AgentAnnotationsTask;
    };

export type AgentAnnotationFilter = "open" | "all";

export type AgentAnnotationsFormatOptions = {
  format?: "markdown" | "json";
  annotations?: AgentAnnotationFilter;
};

export type AgentAnnotationsRedactionManifest = {
  droppedKeys: string[];
  redactedValues: number;
  truncatedValues: number;
};

export type AgentAnnotationsExtensionRedactor = {
  extensionId: string;
  redact(
    data: AgentAnnotationsJsonObject,
    context: { annotationId: string; extensionId: string }
  ): AgentAnnotationsJsonObject | null;
};

export type AgentAnnotationsRedactionResult = {
  task: AgentAnnotationsTask;
  manifest: AgentAnnotationsRedactionManifest;
};

export type AgentAnnotationsSelectionState<T> = {
  targets: T[];
  region?: AgentAnnotationsRect;
};

export type AgentAnnotationsAnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type AgentAnnotationsViewport = { width: number; height: number };

export type AgentAnnotationsPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export type AgentAnnotationsShortcutDefinition = {
  id: string;
  key: string;
  code?: string;
  primary: boolean;
  alt: boolean;
  shift: boolean;
};

export type AgentAnnotationsShortcutInput = {
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

export type AgentAnnotationsPlatform = "mac" | "other";

export interface TaskTransport {
  read(): Promise<AgentAnnotationsTask>;
  mutate(request: AgentAnnotationsMutationRequest): Promise<AgentAnnotationsTask>;
  writeEvidence?(input: {
    taskId: string;
    expectedRevision: number;
    annotationId: string;
    png: string;
    width: number;
    height: number;
  }): Promise<AgentAnnotationsTask>;
  subscribe?(listener: (task: AgentAnnotationsTask) => void): () => void;
}

export type AgentAnnotationsDiagnosticsEntry = {
  source: "console" | "window" | "promise";
  message: string;
  timestamp: string;
};

export type AgentAnnotationsLocaleMessages = Record<string, string>;

export type AgentAnnotationsLocalizedText =
  | string
  | Readonly<Record<string, string>>;

export type AgentAnnotationsIconProps = {
  className?: string;
  size?: number;
};

export interface HostIntegration {
  locale?(): string;
  routeKey?(): string;
  messages?: AgentAnnotationsLocaleMessages;
  identity?(element: Element): Record<string, string>;
}

export interface TargetEnricher {
  id: string;
  enrich(context: {
    element: Element;
    inspection: AgentAnnotationsInspection;
  }): AgentAnnotationsJsonObject | null | Promise<AgentAnnotationsJsonObject | null>;
}

export interface AnnotationRedactor {
  id: string;
  redact(
    data: AgentAnnotationsJsonObject,
    context: { annotationId: string; extensionId: string }
  ): AgentAnnotationsJsonObject | null;
}

export interface AnnotationExporter {
  id: string;
  export(context: {
    task: AgentAnnotationsTask;
    annotations: AgentAnnotationFilter;
  }): string | Promise<string>;
}

export type AgentAnnotationsCaptureMode = "idle" | "pick" | "multi" | "area";

export type AgentAnnotationsToolbarShortcut = Omit<
  AgentAnnotationsShortcutDefinition,
  "id"
>;

export type StudioPublicShortcut = {
  id: string;
  extensionId: string;
  label: string;
  formatted: string;
  shortcut: AgentAnnotationsToolbarShortcut;
};

export type StudioPublicExporter = {
  id: string;
  extensionId: string;
};

export type StudioPublicSnapshot = {
  task: AgentAnnotationsTask;
  captureMode: AgentAnnotationsCaptureMode;
  collapsed: boolean;
  markersVisible: boolean;
  openPanel: string | null;
  diagnostics: readonly AgentAnnotationsDiagnosticsEntry[];
  shortcuts: readonly StudioPublicShortcut[];
  exporters: readonly StudioPublicExporter[];
};

export interface StudioPublicApi {
  getSnapshot(): StudioPublicSnapshot;
  subscribe(listener: (snapshot: StudioPublicSnapshot) => void): () => void;
  commands: {
    capture: {
      startPick(): void;
      startMulti(): void;
      startArea(): void;
      cancel(): void;
    };
    annotations: {
      copyOpen(): Promise<void>;
      complete(id: string): Promise<void>;
      reopen(id: string): Promise<void>;
      remove(id: string): Promise<void>;
      removeCompleted(): Promise<void>;
    };
    markers: {
      show(): void;
      hide(): void;
      focus(annotationId: string): void;
    };
    panels: {
      open(id: string): void;
      close(id?: string): void;
    };
    toolbar: {
      toggleCollapsed(): void;
    };
    exporters: {
      format(
        id?: string,
        annotations?: AgentAnnotationFilter
      ): Promise<string>;
      copy(
        id?: string,
        annotations?: AgentAnnotationFilter
      ): Promise<void>;
    };
  };
}

export type AgentAnnotationsExtensionContext = {
  readonly transport: TaskTransport;
  readonly studio: StudioPublicApi;
};

export type ToolbarCommandContext = {
  readonly studio: StudioPublicApi;
  extensionId: string;
};

export interface ToolbarContribution {
  id: string;
  group: "capture" | "handoff" | "view" | "host";
  order?: number;
  label: AgentAnnotationsLocalizedText;
  icon: import("react").ComponentType<AgentAnnotationsIconProps>;
  shortcut?: AgentAnnotationsToolbarShortcut;
  kind: "action" | "toggle" | "panel";
  isVisible?(snapshot: StudioPublicSnapshot): boolean;
  isEnabled?(snapshot: StudioPublicSnapshot): boolean;
  isPressed?(snapshot: StudioPublicSnapshot): boolean;
  execute?(context: ToolbarCommandContext): void | Promise<void>;
  panelId?: string;
}

export interface PanelContribution {
  id: string;
  title: AgentAnnotationsLocalizedText;
  render: import("react").ComponentType<{
    studio: StudioPublicApi;
    close(): void;
  }>;
  placement?: "above" | "below" | "auto";
  exclusiveGroup?: string;
}

export type MountAgentAnnotationsOptions = {
  transport: TaskTransport;
  extensions?: readonly AgentAnnotationsClientExtension[];
};

export interface AgentAnnotationsClientExtension {
  id: string;
  apiVersion: 1;
  setup?(context: AgentAnnotationsExtensionContext): void | (() => void);
  toolbar?: readonly ToolbarContribution[];
  panels?: readonly PanelContribution[];
  host?: HostIntegration;
  targetEnrichers?: readonly TargetEnricher[];
  redactors?: readonly AnnotationRedactor[];
  exporters?: readonly AnnotationExporter[];
  messages?: AgentAnnotationsLocaleMessages;
}

export type MountedAgentAnnotations = {
  api: StudioPublicApi;
  unmount(): void;
};
