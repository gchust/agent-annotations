import { describe, expect, it } from "vitest";

import {
  AGENT_ANNOTATIONS_TASK_SCHEMA,
  AGENT_ANNOTATIONS_TASK_SCHEMA_VERSION,
  createAgentAnnotationsTask,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_KEYS,
  MAX_EXTENSION_NAMESPACES,
  MAX_TASK_BYTES,
  parseAgentAnnotationsTask,
  setAnnotationExtension,
  validateAgentAnnotationsTask,
} from "../../src/core/index.js";
import { annotationFixture, targetFixture, taskFixture } from "./test-data.js";
import type {
  AgentAnnotationsRegion,
  AgentAnnotationsTarget,
} from "../../src/types/index.js";

describe("agent-annotations.task.v1 schema", () => {
  it("uses the frozen schema constants and creates a valid task", () => {
    expect(AGENT_ANNOTATIONS_TASK_SCHEMA).toBe("agent-annotations.task.v1");
    expect(AGENT_ANNOTATIONS_TASK_SCHEMA_VERSION).toBe(1);
    const task = createAgentAnnotationsTask({
      taskId: "task-new",
      createdAt: "2026-08-12T12:00:00.000Z",
    });
    expect(task).toMatchObject({
      schema: "agent-annotations.task.v1",
      schemaVersion: 1,
      taskRevision: 0,
      status: "active",
      annotations: [],
    });
  });

  it("accepts a complete legal task", () => {
    expect(parseAgentAnnotationsTask(taskFixture())).toEqual(taskFixture());
  });

  it("rejects unknown top-level fields and any other schema version", () => {
    expect(validateAgentAnnotationsTask({ ...taskFixture(), extra: true })).toMatchObject({
      ok: false,
      issue: { code: "unknown_field", path: "task.extra" },
    });
    for (const schemaVersion of [0, 2, 6]) {
      expect(
        validateAgentAnnotationsTask({ ...taskFixture(), schemaVersion })
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
    expect(validateAgentAnnotationsTask(withExtension({ bad: undefined }))).toMatchObject({
      ok: false,
      issue: { code: "non_json_value" },
    });
    expect(validateAgentAnnotationsTask(withExtension({ bad: Number.NaN }))).toMatchObject({
      ok: false,
      issue: { code: "non_json_value" },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateAgentAnnotationsTask(withExtension(cyclic))).toMatchObject({
      ok: false,
      issue: { code: "non_json_value" },
    });
    expect(
      validateAgentAnnotationsTask(
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
      validateAgentAnnotationsTask(
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

  it("rejects values that cannot round-trip through the JSON task contract", () => {
    const sourceStack = new Array(1);
    expect(
      validateAgentAnnotationsTask(
        taskFixture({
          annotations: [
            annotationFixture({
              targets: [
                targetFixture({
                  inspection: { ...targetFixture().inspection, sourceStack },
                }),
              ],
            }),
          ],
        })
      )
    ).toMatchObject({
      ok: false,
      issue: { path: "task.annotations[0].targets[0].inspection.sourceStack[0]" },
    });
    expect(
      validateAgentAnnotationsTask({
        ...taskFixture(),
        taskRevision: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toMatchObject({
      ok: false,
      issue: { path: "task.taskRevision", code: "invalid_value" },
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
    expect(validateAgentAnnotationsTask(oversized)).toMatchObject({
      ok: false,
      issue: { code: "limit_exceeded" },
    });
  });

  it("accepts region annotations with 0-50 individually validated targets", () => {
    const region: AgentAnnotationsRegion = {
      coordinateSpace: "document",
      x: 1,
      y: 2,
      width: 300,
      height: 100,
    };
    const regionAnnotation = (targets: AgentAnnotationsTarget[]) =>
      taskFixture({
        annotations: [annotationFixture({ kind: "region", targets, region })],
      });
    expect(validateAgentAnnotationsTask(regionAnnotation([])).ok).toBe(true);
    expect(validateAgentAnnotationsTask(regionAnnotation([targetFixture()])).ok).toBe(true);
    expect(
      validateAgentAnnotationsTask(
        regionAnnotation(Array.from({ length: 50 }, () => targetFixture()))
      ).ok
    ).toBe(true);
    expect(
      validateAgentAnnotationsTask(
        regionAnnotation(Array.from({ length: 51 }, () => targetFixture()))
      )
    ).toMatchObject({ ok: false, issue: { path: "task.annotations[0].targets" } });
    expect(
      validateAgentAnnotationsTask(
        regionAnnotation([
          { ...targetFixture(), selector: 42 } as unknown as AgentAnnotationsTarget,
        ])
      )
    ).toMatchObject({
      ok: false,
      issue: { path: "task.annotations[0].targets[0].selector" },
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
      validateAgentAnnotationsTask(
        taskFixture({ annotations: [annotationFixture({ extensions })] })
      )
    ).toMatchObject({ ok: false, issue: { code: "limit_exceeded" } });
  });
});
