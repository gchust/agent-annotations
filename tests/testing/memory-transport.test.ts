import { describe, expect, it } from "vitest";

import { MemoryTaskTransport } from "../../src/testing/index.js";

describe("MemoryTaskTransport", () => {
  it("owns revisions without leaking mutable task references", async () => {
    const transport = new MemoryTaskTransport();
    const task = await transport.read();
    task.taskId = "mutated";
    const fresh = await transport.read();
    expect(fresh.taskId).not.toBe("mutated");
    await expect(
      transport.mutate({ taskId: fresh.taskId, expectedRevision: 99, operations: [{ op: "removeCompleted" }] })
    ).rejects.toThrow("revision_conflict");
  });
});
