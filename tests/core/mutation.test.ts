import { describe, expect, it } from "vitest";

import { applyAgentFeedbackMutation } from "../../src/core/index.js";
import { annotationFixture, taskFixture } from "./test-data.js";

const updatedAt = "2026-08-12T12:01:00.000Z";

describe("revision-aware mutations", () => {
  it("applies add/update/complete/reopen/remove/removeCompleted", () => {
    const added = applyAgentFeedbackMutation(
      taskFixture(),
      {
        taskId: "task-1",
        expectedRevision: 0,
        operations: [
          { op: "add", annotation: annotationFixture({ annotationId: "ann-2" }) },
          { op: "update", annotationId: "ann-1", comment: "Updated" },
        ],
      },
      updatedAt
    );
    expect(added).toMatchObject({ ok: true, task: { taskRevision: 1 } });
    if (!added.ok) return;
    expect(added.task.annotations.map((annotation) => annotation.comment)).toEqual([
      "Updated",
      "Make this clearer",
    ]);

    const completed = applyAgentFeedbackMutation(
      added.task,
      {
        taskId: "task-1",
        expectedRevision: 1,
        operations: [
          {
            op: "complete",
            annotationId: "ann-1",
            evidence: { verified: true, summary: "Checked", source: "test" },
          },
        ],
      },
      "2026-08-12T12:02:00.000Z"
    );
    if (!completed.ok) return;
    expect(completed.task.annotations[0]).toMatchObject({
      status: "completed",
      completedAt: "2026-08-12T12:02:00.000Z",
      completionEvidence: { completedAt: "2026-08-12T12:02:00.000Z" },
    });

    const reopened = applyAgentFeedbackMutation(
      completed.task,
      {
        taskId: "task-1",
        expectedRevision: 2,
        operations: [{ op: "reopen", annotationId: "ann-1" }],
      },
      "2026-08-12T12:03:00.000Z"
    );
    if (!reopened.ok) return;
    expect(reopened.task.annotations[0]).toMatchObject({ status: "open" });
    expect(reopened.task.annotations[0].completedAt).toBeUndefined();

    const removed = applyAgentFeedbackMutation(
      reopened.task,
      {
        taskId: "task-1",
        expectedRevision: 3,
        operations: [
          { op: "complete", annotationId: "ann-2" },
          { op: "removeCompleted" },
          { op: "remove", annotationId: "ann-1" },
        ],
      },
      "2026-08-12T12:04:00.000Z"
    );
    expect(removed).toMatchObject({
      ok: true,
      task: { annotations: [], taskRevision: 4, updatedAt: "2026-08-12T12:04:00.000Z" },
    });
  });

  it("returns a deterministic conflict without changing the task", () => {
    const task = taskFixture({ taskRevision: 7 });
    expect(
      applyAgentFeedbackMutation(
        task,
        {
          taskId: "task-1",
          expectedRevision: 6,
          operations: [{ op: "update", annotationId: "ann-1", comment: "stale" }],
        },
        updatedAt
      )
    ).toEqual({
      ok: false,
      error: "revision_conflict",
      expectedRevision: 6,
      actualRevision: 7,
      task,
    });
  });

  it("rejects missing annotations atomically and preserves other namespaces", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({ extensions: { "first.context": { keep: true } } }),
      ],
    });
    const failed = applyAgentFeedbackMutation(
      task,
      {
        taskId: "task-1",
        expectedRevision: 0,
        operations: [
          {
            op: "setExtension",
            annotationId: "ann-1",
            extensionId: "second.context",
            data: { add: true },
          },
          { op: "remove", annotationId: "missing" },
        ],
      },
      updatedAt
    );
    expect(failed).toEqual({ ok: false, error: "annotation_not_found" });
    expect(task.annotations[0].extensions).toEqual({ "first.context": { keep: true } });
  });
});
