import type {
  AgentAnnotationsExtensionRedactor,
  AgentAnnotationsJsonObject,
  AgentAnnotationsJsonValue,
  AgentAnnotationsRedactionManifest,
  AgentAnnotationsRedactionResult,
  AgentAnnotationsTask,
} from "../types/index.js";
import { parseAgentAnnotationsTask, validateExtensionData } from "./schema.js";

export const REDACTED_VALUE = "[REDACTED]";
export const DEFAULT_REDACTION_STRING_LIMIT = 2_000;

const SECRET_KEY_PATTERN =
  /(?:^|[-_.])(?:authorization|cookie|token|secret|password|api[-_.]?key|input[-_.]?value|value)(?:$|[-_.])/i;
const AUTHORIZATION_PATTERN =
  /\bAuthorization\s*:\s*[^\r\n]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const COOKIE_PATTERN = /\b(?:Set-)?Cookie\s*:\s*[^\r\n]+/gi;
const ASSIGNMENT_PATTERN =
  /(^|[?&\s;,<{])(["']?)((?:access_?|refresh_?)?token|(?:client[_-]?)?secret|password|api[_-]?key|input[_-]?value|value)\2(\s*[:=]\s*)(?:(["])([^"]*)"|(['])([^']*)'|([^\s&;,"'>}]+))/gi;

type RedactionRecorder = {
  droppedKeys: Set<string>;
  redactedValues: number;
  truncatedValues: number;
};

const createRecorder = (): RedactionRecorder => ({
  droppedKeys: new Set<string>(),
  redactedValues: 0,
  truncatedValues: 0,
});

const manifest = (recorder: RedactionRecorder): AgentAnnotationsRedactionManifest => ({
  droppedKeys: [...recorder.droppedKeys].sort(),
  redactedValues: recorder.redactedValues,
  truncatedValues: recorder.truncatedValues,
});

export function redactAgentAnnotationsText(
  value: string,
  options: { maxLength?: number } = {}
): string {
  return redactText(value, options, undefined);
}

function redactText(
  value: string,
  options: { maxLength?: number },
  recorder: RedactionRecorder | undefined
): string {
  const limit = options.maxLength ?? DEFAULT_REDACTION_STRING_LIMIT;
  const redacted = value
    .replace(AUTHORIZATION_PATTERN, `Authorization: ${REDACTED_VALUE}`)
    .replace(COOKIE_PATTERN, `Cookie: ${REDACTED_VALUE}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`)
    .replace(JWT_PATTERN, REDACTED_VALUE)
    .replace(
      ASSIGNMENT_PATTERN,
      `$1$2$3$2$4$5$7${REDACTED_VALUE}$5$7`
    );
  const truncated =
    redacted.length > limit
      ? `${redacted.slice(0, limit)}…[truncated]`
      : redacted;
  if (recorder && truncated !== value) recorder.redactedValues += 1;
  if (recorder && truncated.length !== redacted.length) {
    recorder.truncatedValues += 1;
  }
  return truncated;
}

function redactJsonValue(
  value: AgentAnnotationsJsonValue,
  recorder: RedactionRecorder
): AgentAnnotationsJsonValue {
  if (typeof value === "string") return redactText(value, {}, recorder);
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, recorder));
  }
  if (value && typeof value === "object") {
    const result: AgentAnnotationsJsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        recorder.droppedKeys.add(key);
        continue;
      }
      result[key] = redactJsonValue(entry, recorder);
    }
    return result;
  }
  return value;
}

const redactStringMap = (
  values: Record<string, string>,
  recorder: RedactionRecorder
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      recorder.droppedKeys.add(key);
      continue;
    }
    result[key] = redactText(value, { maxLength: 500 }, recorder);
  }
  return result;
};

export function redactAgentAnnotationsTask(
  input: unknown,
  redactors: readonly AgentAnnotationsExtensionRedactor[] = []
): AgentAnnotationsRedactionResult {
  const task = parseAgentAnnotationsTask(input);
  const recorder = createRecorder();
  const byExtension = new Map<string, AgentAnnotationsExtensionRedactor[]>();
  for (const redactor of [...redactors].sort(
    (left, right) =>
      left.extensionId.localeCompare(right.extensionId) ||
      left.id.localeCompare(right.id)
  )) {
    const list = byExtension.get(redactor.extensionId);
    if (list) {
      if (list.some((existing) => existing.id === redactor.id)) {
        throw new TypeError(
          `Duplicate extension redactor: ${redactor.extensionId}/${redactor.id}`
        );
      }
      list.push(redactor);
    } else {
      byExtension.set(redactor.extensionId, [redactor]);
    }
  }
  const annotations = task.annotations.map((annotation) => {
    const extensions: Record<string, AgentAnnotationsJsonObject> = {};
    for (const [extensionId, rawData] of Object.entries(annotation.extensions)
      .sort(([left], [right]) => left.localeCompare(right))) {
      const genericData = redactJsonValue(rawData, recorder) as AgentAnnotationsJsonObject;
      let data: AgentAnnotationsJsonObject | null = genericData;
      for (const redactor of byExtension.get(extensionId) ?? []) {
        let next: AgentAnnotationsJsonObject | null;
        try {
          next = redactor.redact(data, {
            annotationId: annotation.annotationId,
            extensionId,
          });
        } catch {
          // A faulty redactor fails closed for its own namespace only: the namespace is
          // dropped and the rest of the task persists with generic redaction intact.
          next = null;
        }
        if (next === null) {
          data = null;
          break;
        }
        data = next;
      }
      if (data === null) continue;
      const extensionIssue = validateExtensionData(data, extensionId);
      if (extensionIssue) {
        throw new TypeError(`${extensionIssue.path}: ${extensionIssue.message}`);
      }
      extensions[extensionId] = redactJsonValue(data, recorder) as AgentAnnotationsJsonObject;
    }
    return {
      ...annotation,
      comment: redactText(annotation.comment, {}, recorder),
      pageContext: {
        ...annotation.pageContext,
        url: redactText(annotation.pageContext.url, {}, recorder),
        routeKey: redactText(
          annotation.pageContext.routeKey,
          {},
          recorder
        ),
        title: redactText(annotation.pageContext.title, {}, recorder),
      },
      evidence: annotation.evidence?.map((entry) => ({
        ...entry,
        ref: redactText(entry.ref, {}, recorder),
      })),
      targets: annotation.targets?.map((target) => ({
        ...target,
        inspection: {
          ...target.inspection,
          accessibleName: redactText(
            target.inspection.accessibleName,
            {},
            recorder
          ),
          text: redactText(target.inspection.text, {}, recorder),
          htmlPreview: redactText(
            target.inspection.htmlPreview,
            {},
            recorder
          ),
          styleText: redactText(
            target.inspection.styleText,
            {},
            recorder
          ),
          attributes: redactStringMap(target.inspection.attributes, recorder),
        },
      })),
      completionEvidence: annotation.completionEvidence
        ? {
            ...annotation.completionEvidence,
            summary: redactText(
              annotation.completionEvidence.summary,
              {},
              recorder
            ),
          }
        : undefined,
      extensions,
    };
  });
  const redactedTask: AgentAnnotationsTask = { ...task, annotations };
  return { task: parseAgentAnnotationsTask(redactedTask), manifest: manifest(recorder) };
}

// The official final persistence boundary for Node integrations (FileTaskStore
// and custom persistent transports): Parse → Generic Redaction → Parse.
// Extension redactors never run here: extensions are browser-only and already
// ran client-side before the task crossed the transport boundary.
export function prepareAgentAnnotationsTaskForPersistence(input: unknown): AgentAnnotationsTask {
  return redactAgentAnnotationsTask(input).task;
}
