import type {
  AgentFeedbackExtensionRedactor,
  AgentFeedbackJsonObject,
  AgentFeedbackJsonValue,
  AgentFeedbackRedactionManifest,
  AgentFeedbackRedactionResult,
  AgentFeedbackTask,
} from "../types/index.js";
import { parseAgentFeedbackTask, validateExtensionData } from "./schema.js";

export const REDACTED_VALUE = "[REDACTED]";
export const DEFAULT_REDACTION_STRING_LIMIT = 2_000;

const SECRET_KEY_PATTERN =
  /(?:^|[-_.])(?:authorization|cookie|token|secret|password|api[-_.]?key|input[-_.]?value|value)(?:$|[-_.])/i;
const AUTHORIZATION_PATTERN =
  /\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s,;]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const COOKIE_PATTERN = /\b(?:Set-)?Cookie\s*:\s*[^\r\n]+/gi;
const ASSIGNMENT_PATTERN =
  /(^|[?&\s;,])((?:access_?|refresh_?)?token|secret|password|api[_-]?key|input[_-]?value|value)\s*[:=]\s*[^\s&;,"']+/gi;

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

const manifest = (recorder: RedactionRecorder): AgentFeedbackRedactionManifest => ({
  droppedKeys: [...recorder.droppedKeys].sort(),
  redactedValues: recorder.redactedValues,
  truncatedValues: recorder.truncatedValues,
});

export function redactAgentFeedbackText(
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
    .replace(ASSIGNMENT_PATTERN, `$1$2=${REDACTED_VALUE}`);
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
  value: AgentFeedbackJsonValue,
  recorder: RedactionRecorder
): AgentFeedbackJsonValue {
  if (typeof value === "string") return redactText(value, {}, recorder);
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, recorder));
  }
  if (value && typeof value === "object") {
    const result: AgentFeedbackJsonObject = {};
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

export function redactAgentFeedbackTask(
  input: unknown,
  redactors: readonly AgentFeedbackExtensionRedactor[] = []
): AgentFeedbackRedactionResult {
  const task = parseAgentFeedbackTask(input);
  const recorder = createRecorder();
  const byExtension = new Map<string, AgentFeedbackExtensionRedactor>();
  for (const redactor of redactors) {
    if (byExtension.has(redactor.extensionId)) {
      throw new TypeError(`Duplicate extension redactor: ${redactor.extensionId}`);
    }
    byExtension.set(redactor.extensionId, redactor);
  }
  const annotations = task.annotations.map((annotation) => {
    const extensions: Record<string, AgentFeedbackJsonObject> = {};
    for (const [extensionId, rawData] of Object.entries(annotation.extensions)) {
      const genericData = redactJsonValue(rawData, recorder) as AgentFeedbackJsonObject;
      const extensionData = byExtension.get(extensionId)?.redact(genericData, {
        annotationId: annotation.annotationId,
        extensionId,
      });
      const data = extensionData === undefined ? genericData : extensionData;
      if (data === null) continue;
      const extensionIssue = validateExtensionData(data, extensionId);
      if (extensionIssue) {
        throw new TypeError(`${extensionIssue.path}: ${extensionIssue.message}`);
      }
      extensions[extensionId] = redactJsonValue(data, recorder) as AgentFeedbackJsonObject;
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
  const redactedTask: AgentFeedbackTask = { ...task, annotations };
  return { task: parseAgentFeedbackTask(redactedTask), manifest: manifest(recorder) };
}
