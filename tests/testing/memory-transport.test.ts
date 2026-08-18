import { describe, expect, it } from "vitest";

import { RevisionConflictError } from "../../src/core/index.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";

describe("MemoryTaskTransport", () => {
  it("owns revisions without leaking mutable task references", async () => {
    const transport = new MemoryTaskTransport();
    const task = await transport.read();
    task.taskId = "mutated";
    const fresh = await transport.read();
    expect(fresh.taskId).not.toBe("mutated");
    const conflict = await transport.mutate({
      taskId: fresh.taskId,
      expectedRevision: 99,
      operations: [{ op: "removeCompleted" }],
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(RevisionConflictError);
    expect((conflict as RevisionConflictError).expectedRevision).toBe(99);
    expect((conflict as RevisionConflictError).actualRevision).toBe(0);
    expect((conflict as RevisionConflictError).latestTask.taskId).toBe(fresh.taskId);
  });
});
