import type {
  AgentAnnotation,
  AgentAnnotationsCompletionEvidence,
  AgentAnnotationsEvidenceReference,
  AgentAnnotationsExtensionData,
  AgentAnnotationsInspection,
  AgentAnnotationsJsonObject,
  AgentAnnotationsPageContext,
  AgentAnnotationsRect,
  AgentAnnotationsRegion,
  AgentAnnotationsSourceLocation,
  AgentAnnotationsTarget,
  AgentAnnotationsTask,
  AgentAnnotationsValidationIssue,
  AgentAnnotationsValidationResult,
  CreateAgentAnnotationsTaskInput,
} from "../types/index.js";

export const AGENT_ANNOTATIONS_TASK_SCHEMA = "agent-annotations.task.v1" as const;
export const AGENT_ANNOTATIONS_TASK_SCHEMA_VERSION = 1 as const;

export const MAX_ANNOTATIONS = 50;
export const MAX_TARGETS_PER_ANNOTATION = 50;
export const MAX_EVIDENCE_REFERENCES = 20;
export const MAX_SOURCE_STACK = 12;
export const MAX_INSPECTION_ATTRIBUTES = 50;
export const MAX_EXTENSION_NAMESPACES = 20;
export const MAX_EXTENSION_KEYS = 64;
export const MAX_EXTENSION_BYTES = 16 * 1024;
export const MAX_EXTENSION_DEPTH = 8;
export const MAX_EXTENSION_ARRAY_ITEMS = 100;
export const MAX_TASK_BYTES = 256 * 1024;

export const AGENT_ANNOTATIONS_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const EXTENSION_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const MAX_URL_LENGTH = 2_048;
const MAX_ROUTE_LENGTH = 1_024;
const MAX_TITLE_LENGTH = 500;
const MAX_COMMENT_LENGTH = 4_000;
const MAX_SELECTOR_LENGTH = 4_096;
const MAX_INSPECTION_TEXT_LENGTH = 8_000;
const MAX_EXTENSION_STRING_LENGTH = 8_000;

const issue = (
  path: string,
  code: AgentAnnotationsValidationIssue["code"],
  message: string
): AgentAnnotationsValidationIssue => ({ path, code, message });

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const unknownField = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): AgentAnnotationsValidationIssue | null => {
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate));
  return key
    ? issue(`${path}.${key}`, "unknown_field", `Unknown field: ${key}`)
    : null;
};

const stringIssue = (
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false
): AgentAnnotationsValidationIssue | null => {
  if (typeof value !== "string") {
    return issue(path, "invalid_type", "Expected a string");
  }
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    return issue(path, "limit_exceeded", `Expected 1-${maxLength} characters`);
  }
  return null;
};

const finiteNumberIssue = (
  value: unknown,
  path: string,
  options: { integer?: boolean; min?: number } = {}
): AgentAnnotationsValidationIssue | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return issue(path, "invalid_type", "Expected a finite number");
  }
  if (options.integer && !Number.isSafeInteger(value)) {
    return issue(path, "invalid_value", "Expected a safe integer");
  }
  if (options.min !== undefined && value < options.min) {
    return issue(path, "invalid_value", `Expected a value >= ${options.min}`);
  }
  return null;
};

const timestampIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  const stringError = stringIssue(value, path, 40);
  if (stringError) return stringError;
  return Number.isNaN(Date.parse(value as string))
    ? issue(path, "invalid_value", "Expected an ISO timestamp")
    : new Date(value as string).toISOString() === value
      ? null
      : issue(path, "invalid_value", "Expected a canonical ISO timestamp");
};

const rectIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(value, ["x", "y", "width", "height"], path);
  if (extra) return extra;
  return rectValuesIssue(value, path);
};

const rectValuesIssue = (
  value: Record<string, unknown>,
  path: string
): AgentAnnotationsValidationIssue | null => {
  return (
    finiteNumberIssue(value.x, `${path}.x`) ??
    finiteNumberIssue(value.y, `${path}.y`) ??
    finiteNumberIssue(value.width, `${path}.width`, { min: 0 }) ??
    finiteNumberIssue(value.height, `${path}.height`, { min: 0 })
  );
};

const sourceLocationIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(
    value,
    ["filePath", "lineNumber", "columnNumber", "componentName"],
    path
  );
  if (extra) return extra;
  const componentIssue =
    value.componentName === null
      ? null
      : stringIssue(value.componentName, `${path}.componentName`, 200);
  return (
    stringIssue(value.filePath, `${path}.filePath`, 2_048) ??
    finiteNumberIssue(value.lineNumber, `${path}.lineNumber`, {
      integer: true,
      min: 1,
    }) ??
    finiteNumberIssue(value.columnNumber, `${path}.columnNumber`, {
      integer: true,
      min: 1,
    }) ??
    componentIssue
  );
};

const inspectionIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(
    value,
    [
      "tagName",
      "role",
      "accessibleName",
      "text",
      "componentName",
      "source",
      "sourceStack",
      "htmlPreview",
      "styleText",
      "attributes",
    ],
    path
  );
  if (extra) return extra;
  const componentIssue =
    value.componentName === null
      ? null
      : stringIssue(value.componentName, `${path}.componentName`, 200);
  if (!Array.isArray(value.sourceStack)) {
    return issue(`${path}.sourceStack`, "invalid_type", "Expected an array");
  }
  if (value.sourceStack.length > MAX_SOURCE_STACK) {
    return issue(
      `${path}.sourceStack`,
      "limit_exceeded",
      `At most ${MAX_SOURCE_STACK} source frames are allowed`
    );
  }
  if (!isRecord(value.attributes)) {
    return issue(`${path}.attributes`, "invalid_type", "Expected an object");
  }
  if (Object.keys(value.attributes).length > MAX_INSPECTION_ATTRIBUTES) {
    return issue(
      `${path}.attributes`,
      "limit_exceeded",
      `At most ${MAX_INSPECTION_ATTRIBUTES} attributes are allowed`
    );
  }
  const attributeIssue = Object.entries(value.attributes).reduce<AgentAnnotationsValidationIssue | null>(
    (found, [key, attribute]) =>
      found ??
      stringIssue(key, `${path}.attributes`, 100) ??
      stringIssue(attribute, `${path}.attributes.${key}`, 500, true),
    null
  );
  let stackIssue: AgentAnnotationsValidationIssue | null = null;
  for (let index = 0; index < value.sourceStack.length; index += 1) {
    stackIssue = sourceLocationIssue(
      value.sourceStack[index],
      `${path}.sourceStack[${index}]`
    );
    if (stackIssue) break;
  }
  return (
    stringIssue(value.tagName, `${path}.tagName`, 100) ??
    stringIssue(value.role, `${path}.role`, 100, true) ??
    stringIssue(value.accessibleName, `${path}.accessibleName`, 500, true) ??
    stringIssue(value.text, `${path}.text`, MAX_INSPECTION_TEXT_LENGTH, true) ??
    componentIssue ??
    (value.source === null
      ? null
      : sourceLocationIssue(value.source, `${path}.source`)) ??
    stackIssue ??
    stringIssue(
      value.htmlPreview,
      `${path}.htmlPreview`,
      MAX_INSPECTION_TEXT_LENGTH,
      true
    ) ??
    stringIssue(
      value.styleText,
      `${path}.styleText`,
      MAX_INSPECTION_TEXT_LENGTH,
      true
    ) ??
    attributeIssue
  );
};

const targetIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(value, ["selector", "bounds", "inspection"], path);
  if (extra) return extra;
  return (
    stringIssue(value.selector, `${path}.selector`, MAX_SELECTOR_LENGTH) ??
    rectIssue(value.bounds, `${path}.bounds`) ??
    inspectionIssue(value.inspection, `${path}.inspection`)
  );
};

const pageContextIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(
    value,
    ["url", "routeKey", "title", "viewport", "scroll"],
    path
  );
  if (extra) return extra;
  if (!isRecord(value.viewport)) {
    return issue(`${path}.viewport`, "invalid_type", "Expected an object");
  }
  const viewportExtra = unknownField(
    value.viewport,
    ["width", "height"],
    `${path}.viewport`
  );
  if (viewportExtra) return viewportExtra;
  if (!isRecord(value.scroll)) {
    return issue(`${path}.scroll`, "invalid_type", "Expected an object");
  }
  const scrollExtra = unknownField(value.scroll, ["x", "y"], `${path}.scroll`);
  if (scrollExtra) return scrollExtra;
  return (
    stringIssue(value.url, `${path}.url`, MAX_URL_LENGTH) ??
    stringIssue(value.routeKey, `${path}.routeKey`, MAX_ROUTE_LENGTH) ??
    stringIssue(value.title, `${path}.title`, MAX_TITLE_LENGTH, true) ??
    finiteNumberIssue(value.viewport.width, `${path}.viewport.width`, {
      min: 0,
    }) ??
    finiteNumberIssue(value.viewport.height, `${path}.viewport.height`, {
      min: 0,
    }) ??
    finiteNumberIssue(value.scroll.x, `${path}.scroll.x`) ??
    finiteNumberIssue(value.scroll.y, `${path}.scroll.y`)
  );
};

const evidenceIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(
    value,
    ["kind", "ref", "mediaType", "width", "height", "capturedAt"],
    path
  );
  if (extra) return extra;
  if (value.kind !== "screenshot" && value.kind !== "attachment") {
    return issue(`${path}.kind`, "invalid_value", "Unknown evidence kind");
  }
  return (
    stringIssue(value.ref, `${path}.ref`, 2_048) ??
    (value.mediaType === undefined
      ? null
      : stringIssue(value.mediaType, `${path}.mediaType`, 200)) ??
    (value.width === undefined
      ? null
      : finiteNumberIssue(value.width, `${path}.width`, { min: 0 })) ??
    (value.height === undefined
      ? null
      : finiteNumberIssue(value.height, `${path}.height`, { min: 0 })) ??
    (value.capturedAt === undefined
      ? null
      : timestampIssue(value.capturedAt, `${path}.capturedAt`))
  );
};

const completionEvidenceIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const extra = unknownField(
    value,
    ["verified", "summary", "source", "completedAt"],
    path
  );
  if (extra) return extra;
  return (
    (typeof value.verified === "boolean"
      ? null
      : issue(`${path}.verified`, "invalid_type", "Expected a boolean")) ??
    stringIssue(value.summary, `${path}.summary`, 2_000, true) ??
    stringIssue(value.source, `${path}.source`, 100) ??
    timestampIssue(value.completedAt, `${path}.completedAt`)
  );
};

export function validateExtensionId(
  extensionId: unknown,
  path = "extensionId"
): AgentAnnotationsValidationIssue | null {
  const stringError = stringIssue(extensionId, path, 64);
  if (stringError) return stringError;
  return EXTENSION_ID_PATTERN.test(extensionId as string)
    ? null
    : issue(path, "invalid_value", "Invalid extension namespace")
}

export function validateExtensionData(
  value: unknown,
  path = "extension"
): AgentAnnotationsValidationIssue | null {
  if (!isRecord(value)) {
    return issue(path, "invalid_type", "Extension data must be a JSON object");
  }
  const seen = new WeakSet<object>();
  let keys = 0;

  const visit = (
    current: unknown,
    currentPath: string,
    depth: number
  ): AgentAnnotationsValidationIssue | null => {
    if (
      current === null ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      return null;
    }
    if (typeof current === "string") {
      return current.length <= MAX_EXTENSION_STRING_LENGTH
        ? null
        : issue(
            currentPath,
            "limit_exceeded",
            `Extension strings are limited to ${MAX_EXTENSION_STRING_LENGTH} characters`
          );
    }
    if (typeof current !== "object" || current === null) {
      return issue(currentPath, "non_json_value", "Extension data must be JSON-safe");
    }
    if (seen.has(current)) {
      return issue(currentPath, "non_json_value", "Cyclic extension data is not JSON-safe");
    }
    if (depth >= MAX_EXTENSION_DEPTH) {
      return issue(
        currentPath,
        "limit_exceeded",
        `Extension data depth is limited to ${MAX_EXTENSION_DEPTH}`
      );
    }
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_EXTENSION_ARRAY_ITEMS) {
        return issue(
          currentPath,
          "limit_exceeded",
          `Extension arrays are limited to ${MAX_EXTENSION_ARRAY_ITEMS} items`
        );
      }
      for (const [index, item] of current.entries()) {
        const found = visit(item, `${currentPath}[${index}]`, depth + 1);
        if (found) return found;
      }
      seen.delete(current);
      return null;
    }
    if (!isRecord(current)) {
      return issue(currentPath, "non_json_value", "Only plain JSON objects are allowed");
    }
    const entries = Object.entries(current);
    keys += entries.length;
    if (keys > MAX_EXTENSION_KEYS) {
      return issue(
        currentPath,
        "limit_exceeded",
        `Extension data is limited to ${MAX_EXTENSION_KEYS} keys`
      );
    }
    for (const [key, item] of entries) {
      const keyError = stringIssue(key, currentPath, 100);
      if (keyError) return keyError;
      const found = visit(item, `${currentPath}.${key}`, depth + 1);
      if (found) return found;
    }
    seen.delete(current);
    return null;
  };

  const found = visit(value, path, 0);
  if (found) return found;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return bytes <= MAX_EXTENSION_BYTES
    ? null
    : issue(
        path,
        "limit_exceeded",
        `Extension data is limited to ${MAX_EXTENSION_BYTES} bytes`
      );
}

const extensionsIssue = (
  value: unknown,
  path: string
): AgentAnnotationsValidationIssue | null => {
  if (!isRecord(value)) return issue(path, "invalid_type", "Expected an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_EXTENSION_NAMESPACES) {
    return issue(
      path,
      "limit_exceeded",
      `At most ${MAX_EXTENSION_NAMESPACES} extension namespaces are allowed`
    );
  }
  for (const [extensionId, data] of entries) {
    const found =
      validateExtensionId(extensionId, `${path}.${extensionId}`) ??
      validateExtensionData(data, `${path}.${extensionId}`);
    if (found) return found;
  }
  return null;
};

export function validateAgentAnnotation(
  input: unknown,
  path = "annotation"
): AgentAnnotationsValidationResult<AgentAnnotation> {
  if (!isRecord(input)) {
    return { ok: false, issue: issue(path, "invalid_type", "Expected an object") };
  }
  const extra = unknownField(
    input,
    [
      "annotationId",
      "kind",
      "comment",
      "status",
      "createdAt",
      "completedAt",
      "completionEvidence",
      "pageContext",
      "targets",
      "region",
      "evidence",
      "extensions",
    ],
    path
  );
  if (extra) return { ok: false, issue: extra };
  const idError = stringIssue(input.annotationId, `${path}.annotationId`, 64);
  if (idError) return { ok: false, issue: idError };
  if (!AGENT_ANNOTATIONS_ID_PATTERN.test(input.annotationId as string)) {
    return {
      ok: false,
      issue: issue(`${path}.annotationId`, "invalid_value", "Invalid annotation ID"),
    };
  }
  if (input.kind !== "element" && input.kind !== "multi" && input.kind !== "region") {
    return {
      ok: false,
      issue: issue(`${path}.kind`, "invalid_value", "Unknown annotation kind"),
    };
  }
  if (input.status !== "open" && input.status !== "completed") {
    return {
      ok: false,
      issue: issue(`${path}.status`, "invalid_value", "Unknown annotation status"),
    };
  }
  const commonError =
    stringIssue(input.comment, `${path}.comment`, MAX_COMMENT_LENGTH, true) ??
    timestampIssue(input.createdAt, `${path}.createdAt`) ??
    pageContextIssue(input.pageContext, `${path}.pageContext`) ??
    extensionsIssue(input.extensions, `${path}.extensions`);
  if (commonError) return { ok: false, issue: commonError };

  if (input.status === "open") {
    if (input.completedAt !== undefined || input.completionEvidence !== undefined) {
      return {
        ok: false,
        issue: issue(
          `${path}.completedAt`,
          "invalid_value",
          "Open annotations cannot carry completion data"
        ),
      };
    }
  } else {
    const completedAtError = timestampIssue(input.completedAt, `${path}.completedAt`);
    if (completedAtError) return { ok: false, issue: completedAtError };
    if (input.completionEvidence !== undefined) {
      const evidenceError = completionEvidenceIssue(
        input.completionEvidence,
        `${path}.completionEvidence`
      );
      if (evidenceError) return { ok: false, issue: evidenceError };
      if (
        (input.completionEvidence as AgentAnnotationsCompletionEvidence).completedAt !==
        input.completedAt
      ) {
        return {
          ok: false,
          issue: issue(
            `${path}.completionEvidence.completedAt`,
            "invalid_value",
            "Completion timestamps must match"
          ),
        };
      }
    }
  }

  if (input.kind === "region") {
    if (input.targets !== undefined || !isRecord(input.region)) {
      return {
        ok: false,
        issue: issue(
          path,
          "invalid_value",
          "Region annotations require region and cannot carry targets"
        ),
      };
    }
    const regionExtra = unknownField(
      input.region,
      ["coordinateSpace", "x", "y", "width", "height"],
      `${path}.region`
    );
    const regionError =
      regionExtra ??
      (input.region.coordinateSpace === "document"
        ? null
        : issue(
            `${path}.region.coordinateSpace`,
            "invalid_value",
            "Expected document coordinates"
          )) ??
      rectValuesIssue(input.region, `${path}.region`);
    if (regionError) return { ok: false, issue: regionError };
  } else {
    if (input.region !== undefined || !Array.isArray(input.targets)) {
      return {
        ok: false,
        issue: issue(
          path,
          "invalid_value",
          "Element annotations require targets and cannot carry a region"
        ),
      };
    }
    const expectedMinimum = input.kind === "element" ? 1 : 2;
    const expectedMaximum = input.kind === "element" ? 1 : MAX_TARGETS_PER_ANNOTATION;
    if (
      input.targets.length < expectedMinimum ||
      input.targets.length > expectedMaximum
    ) {
      return {
        ok: false,
        issue: issue(
          `${path}.targets`,
          "limit_exceeded",
          `${input.kind} annotations require ${expectedMinimum}-${expectedMaximum} targets`
        ),
      };
    }
    for (const [index, target] of input.targets.entries()) {
      const found = targetIssue(target, `${path}.targets[${index}]`);
      if (found) return { ok: false, issue: found };
    }
  }

  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence)) {
      return {
        ok: false,
        issue: issue(`${path}.evidence`, "invalid_type", "Expected an array"),
      };
    }
    if (input.evidence.length > MAX_EVIDENCE_REFERENCES) {
      return {
        ok: false,
        issue: issue(
          `${path}.evidence`,
          "limit_exceeded",
          `At most ${MAX_EVIDENCE_REFERENCES} evidence references are allowed`
        ),
      };
    }
    for (const [index, evidence] of input.evidence.entries()) {
      const found = evidenceIssue(evidence, `${path}.evidence[${index}]`);
      if (found) return { ok: false, issue: found };
    }
  }
  return { ok: true, value: input as AgentAnnotation };
}

export function validateAgentAnnotationsTask(
  input: unknown
): AgentAnnotationsValidationResult<AgentAnnotationsTask> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issue: issue("task", "invalid_type", "Expected an object"),
    };
  }
  const extra = unknownField(
    input,
    [
      "schema",
      "schemaVersion",
      "taskId",
      "taskRevision",
      "status",
      "createdAt",
      "updatedAt",
      "annotations",
    ],
    "task"
  );
  if (extra) return { ok: false, issue: extra };
  if (input.schema !== AGENT_ANNOTATIONS_TASK_SCHEMA) {
    return {
      ok: false,
      issue: issue("task.schema", "invalid_value", "Unknown task schema"),
    };
  }
  if (input.schemaVersion !== AGENT_ANNOTATIONS_TASK_SCHEMA_VERSION) {
    return {
      ok: false,
      issue: issue("task.schemaVersion", "invalid_value", "Unknown schema version"),
    };
  }
  const idError = stringIssue(input.taskId, "task.taskId", 64);
  if (idError) return { ok: false, issue: idError };
  if (!AGENT_ANNOTATIONS_ID_PATTERN.test(input.taskId as string)) {
    return {
      ok: false,
      issue: issue("task.taskId", "invalid_value", "Invalid task ID"),
    };
  }
  const commonError =
    finiteNumberIssue(input.taskRevision, "task.taskRevision", {
      integer: true,
      min: 0,
    }) ??
    timestampIssue(input.createdAt, "task.createdAt") ??
    timestampIssue(input.updatedAt, "task.updatedAt");
  if (commonError) return { ok: false, issue: commonError };
  if (input.status !== "active" && input.status !== "completed") {
    return {
      ok: false,
      issue: issue("task.status", "invalid_value", "Unknown task status"),
    };
  }
  if (!Array.isArray(input.annotations)) {
    return {
      ok: false,
      issue: issue("task.annotations", "invalid_type", "Expected an array"),
    };
  }
  if (input.annotations.length > MAX_ANNOTATIONS) {
    return {
      ok: false,
      issue: issue(
        "task.annotations",
        "limit_exceeded",
        `At most ${MAX_ANNOTATIONS} annotations are allowed`
      ),
    };
  }
  const ids = new Set<string>();
  for (const [index, annotation] of input.annotations.entries()) {
    const result = validateAgentAnnotation(
      annotation,
      `task.annotations[${index}]`
    );
    if (!result.ok) return result;
    if (ids.has(result.value.annotationId)) {
      return {
        ok: false,
        issue: issue(
          `task.annotations[${index}].annotationId`,
          "invalid_value",
          "Annotation IDs must be unique"
        ),
      };
    }
    ids.add(result.value.annotationId);
  }
  const hasOpen = (input.annotations as AgentAnnotation[]).some(
    (annotation) => annotation.status === "open"
  );
  if (input.status === "completed" && hasOpen) {
    return {
      ok: false,
      issue: issue(
        "task.status",
        "invalid_value",
        "Completed tasks cannot contain open annotations"
      ),
    };
  }
  if (
    input.status === "active" &&
    input.annotations.length > 0 &&
    !hasOpen
  ) {
    return {
      ok: false,
      issue: issue(
        "task.status",
        "invalid_value",
        "A task with only completed annotations must be completed"
      ),
    };
  }
  if (Date.parse(input.updatedAt as string) < Date.parse(input.createdAt as string)) {
    return {
      ok: false,
      issue: issue(
        "task.updatedAt",
        "invalid_value",
        "updatedAt cannot be earlier than createdAt"
      ),
    };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > MAX_TASK_BYTES) {
    return {
      ok: false,
      issue: issue(
        "task",
        "limit_exceeded",
        `Tasks are limited to ${MAX_TASK_BYTES} bytes`
      ),
    };
  }
  return { ok: true, value: input as AgentAnnotationsTask };
}

export class AgentAnnotationsValidationError extends Error {
  readonly issue: AgentAnnotationsValidationIssue;

  constructor(validationIssue: AgentAnnotationsValidationIssue) {
    super(`${validationIssue.path}: ${validationIssue.message}`);
    this.name = "AgentAnnotationsValidationError";
    this.issue = validationIssue;
  }
}

export function parseAgentAnnotationsTask(input: unknown): AgentAnnotationsTask {
  const result = validateAgentAnnotationsTask(input);
  if (!result.ok) throw new AgentAnnotationsValidationError(result.issue);
  return result.value;
}

export const isAgentAnnotationsTask = (input: unknown): input is AgentAnnotationsTask =>
  validateAgentAnnotationsTask(input).ok;

export function createAgentAnnotationsTask(
  input: CreateAgentAnnotationsTaskInput
): AgentAnnotationsTask {
  const annotations = input.annotations ?? [];
  const task: AgentAnnotationsTask = {
    schema: AGENT_ANNOTATIONS_TASK_SCHEMA,
    schemaVersion: AGENT_ANNOTATIONS_TASK_SCHEMA_VERSION,
    taskId: input.taskId,
    taskRevision: 0,
    status:
      annotations.length > 0 &&
      annotations.every((annotation) => annotation.status === "completed")
        ? "completed"
        : "active",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    annotations: [...annotations],
  };
  return parseAgentAnnotationsTask(task);
}

export function setAnnotationExtension(
  annotation: AgentAnnotation,
  extensionId: string,
  data: AgentAnnotationsJsonObject
): AgentAnnotation {
  const found =
    validateExtensionId(extensionId) ?? validateExtensionData(data, extensionId);
  if (found) throw new AgentAnnotationsValidationError(found);
  const next = {
    ...annotation,
    extensions: { ...annotation.extensions, [extensionId]: data },
  };
  const result = validateAgentAnnotation(next);
  if (!result.ok) throw new AgentAnnotationsValidationError(result.issue);
  return result.value;
}
