import { describe, expect, it } from "vitest";

import {
  AGENT_FEEDBACK_TASK_SCHEMA,
  AGENT_FEEDBACK_TASK_SCHEMA_VERSION,
  createAgentFeedbackTask,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_KEYS,
  MAX_EXTENSION_NAMESPACES,
  MAX_TASK_BYTES,
  parseAgentFeedbackTask,
  setAnnotationExtension,
  validateAgentFeedbackTask,
} from "../../src/core/index.js";
import { annotationFixture, targetFixture, taskFixture } from "./test-data.js";

describe("agent-feedback.task.v1 schema", () => {
  it("uses the frozen schema constants and creates a valid task", () => {
    expect(AGENT_FEEDBACK_TASK_SCHEMA).toBe("agent-feedback.task.v1");
    expect(AGENT_FEEDBACK_TASK_SCHEMA_VERSION).toBe(1);
    const task = createAgentFeedbackTask({
      taskId: "task-new",
      createdAt: "2026-08-12T12:00:00.000Z",
    });
    expect(task).toMatchObject({
      schema: "agent-feedback.task.v1",
      schemaVersion: 1,
      taskRevision: 0,
      status: "active",
      annotations: [],
    });
  });

  it("accepts a complete legal task", () => {
    expect(parseAgentFeedbackTask(taskFixture())).toEqual(taskFixture());
  });

  it("rejects unknown top-level fields and any other schema version", () => {
    expect(validateAgentFeedbackTask({ ...taskFixture(), extra: true })).toMatchObject({
      ok: false,
      issue: { code: "unknown_field", path: "task.extra" },
    });
    for (const schemaVersion of [0, 2, 6]) {
      expect(
        validateAgentFeedbackTask({ ...taskFixture(), schemaVersion })
      ).toMatchObject({
        ok: false,
        issue: { path: "task.schemaVersion" },
      });
    }
  });

  it("rejects non-JSON and over-limit extension data", () => {
    const withExtension = (data: unknown) => ({
      ...taskFixture(),
      annotations: [
        {
          ...annotationFixture(),
          extensions: { "demo.context": data },
        },
      ],
    });
    expect(validateAgentFeedbackTask(withExtension({ bad: undefined }))).toMatchObject({
      ok: false,
      issue: { code: "non_json_value" },
    });
    expect(validateAgentFeedbackTask(withExtension({ bad: Number.NaN }))).toMatchObject({
      ok: false,
      issue: { code: "non_json_value" },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateAgentFeedbackTask(withExtension(cyclic))).toMatchObject({
      ok: false,
      issue: { code: "non_json_value" },
    });
    expect(
      validateAgentFeedbackTask(
        withExtension(
          Object.fromEntries(
            Array.from({ length: MAX_EXTENSION_KEYS + 1 }, (_, index) => [
              `key${index}`,
              index,
            ])
          )
        )
      )
    ).toMatchObject({ ok: false, issue: { code: "limit_exceeded" } });
    expect(
      validateAgentFeedbackTask(
        withExtension({
          first: "x".repeat(7_000),
          second: "y".repeat(7_000),
          third: "z".repeat(3_000),
        })
      )
    ).toMatchObject({
      ok: false,
      issue: {
        code: "limit_exceeded",
        message: `Extension data is limited to ${MAX_EXTENSION_BYTES} bytes`,
      },
    });
  });

  it("rejects over-limit task data", () => {
    const repeatedTarget = targetFixture({
      inspection: {
        ...targetFixture().inspection,
        htmlPreview: "x".repeat(8_000),
        styleText: "y".repeat(8_000),
      },
    });
    const oversized = taskFixture({
      annotations: Array.from({ length: 40 }, (_, index) =>
        annotationFixture({
          annotationId: `ann-${index + 1}`,
          kind: "multi",
          targets: Array.from({ length: 2 }, () => repeatedTarget),
        })
      ),
    });
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      MAX_TASK_BYTES
    );
    expect(validateAgentFeedbackTask(oversized)).toMatchObject({
      ok: false,
      issue: { code: "limit_exceeded" },
    });
  });

  it("updates only the requested extension namespace", () => {
    const annotation = annotationFixture({
      extensions: { "first.context": { keep: true } },
    });
    const next = setAnnotationExtension(annotation, "second.context", { added: true });
    expect(next.extensions).toEqual({
      "first.context": { keep: true },
      "second.context": { added: true },
    });
    expect(annotation.extensions).toEqual({ "first.context": { keep: true } });
  });

  it("bounds the extension namespace count", () => {
    const extensions = Object.fromEntries(
      Array.from({ length: MAX_EXTENSION_NAMESPACES + 1 }, (_, index) => [
        `extension.${index}`,
        {},
      ])
    );
    expect(
      validateAgentFeedbackTask(
        taskFixture({ annotations: [annotationFixture({ extensions })] })
      )
    ).toMatchObject({ ok: false, issue: { code: "limit_exceeded" } });
  });
});
