import { describe, expect, it } from "vitest";

import { RevisionConflictError } from "../../src/core/index.js";
import { createValidatedTaskTransport } from "../../src/client/validated-transport.js";
import type { TaskTransport } from "../../src/types/index.js";
import { taskFixture } from "../core/test-data.js";

const valid = taskFixture({ taskRevision: 4 });

const rawTransport = (overrides: Partial<TaskTransport> = {}): TaskTransport => ({
  read: async () => valid,
  mutate: async () => valid,
  ...overrides,
});

describe("createValidatedTaskTransport", () => {
  it("parses every read result", async () => {
    const validated = createValidatedTaskTransport(rawTransport({ read: async () => ({ broken: true }) as never }));
    await expect(validated.read()).rejects.toThrow(/invalid task from transport \(read\)/);
  });

  it("parses every mutate result", async () => {
    const validated = createValidatedTaskTransport(rawTransport({ mutate: async () => ({ broken: true }) as never }));
    await expect(validated.mutate({
      taskId: "task-1",
      expectedRevision: 1,
      operations: [{ op: "removeCompleted" }],
    })).rejects.toThrow(/invalid task from transport \(mutate\)/);
  });

  it("parses every writeEvidence result", async () => {
    const validated = createValidatedTaskTransport(rawTransport({
      writeEvidence: async () => ({ broken: true }) as never,
    }));
    await expect(validated.writeEvidence?.({
      taskId: "task-1",
      expectedRevision: 1,
      annotationId: "ann-1",
      png: "fake",
      width: 10,
      height: 10,
    })).rejects.toThrow(/invalid task from transport \(writeEvidence\)/);
  });

  it("parses every subscribed push before the listener sees it", async () => {
    let publish!: (task: unknown) => void;
    const listener = (task: unknown) => {
      expect(task).toMatchObject({ taskId: "task-1" });
    };
    const validated = createValidatedTaskTransport(rawTransport({
      subscribe(callback) {
        publish = callback as never;
        return () => undefined;
      },
    }));
    const unsubscribe = validated.subscribe?.(listener);
    expect(() => publish({ ...valid, taskRevision: 2, annotations: "broken" })).toThrow(/invalid task from transport \(subscribe\)/);
    unsubscribe?.();
  });

  it("revalidates the latest task carried by a RevisionConflictError", async () => {
    const validated = createValidatedTaskTransport(rawTransport({
      mutate: async () => {
        throw new RevisionConflictError({ invalid: true } as never, 1, 2);
      },
    }));
    await expect(validated.mutate({
      taskId: "task-1",
      expectedRevision: 1,
      operations: [{ op: "removeCompleted" }],
    })).rejects.toThrow(/invalid task from transport \(conflict\)/);
  });

  it("preserves a valid RevisionConflictError", async () => {
    const latest = taskFixture({ taskRevision: 3 });
    const validated = createValidatedTaskTransport(rawTransport({
      mutate: async () => {
        throw new RevisionConflictError(latest, 2, 3);
      },
    }));
    const error = await validated.mutate({
      taskId: latest.taskId,
      expectedRevision: 2,
      operations: [{ op: "removeCompleted" }],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect((error as RevisionConflictError).latestTask.taskRevision).toBe(3);
    expect((error as RevisionConflictError).expectedRevision).toBe(2);
  });

  it("keeps the original transport's own binding for appendDiagnostics", async () => {
    let seen = "";
    const transport = {
      endpoint: "original-endpoint",
      read: async () => valid,
      mutate: async () => valid,
      appendDiagnostics: async function (this: { endpoint: string }) {
        seen = this.endpoint;
      },
    } as unknown as TaskTransport;
    const validated = createValidatedTaskTransport(transport);
    await validated.appendDiagnostics?.([{ source: "console", message: "x", timestamp: "2026-08-12T12:00:00.000Z" }]);
    expect(seen).toBe("original-endpoint");
  });
});
