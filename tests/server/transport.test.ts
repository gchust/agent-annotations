/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";

import { RevisionConflictError } from "../../src/core/index.js";
import { HttpTaskTransport } from "../../src/server/transport.js";
import { taskFixture } from "../core/test-data.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stubTaskResponse = (task: unknown, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { task } : { error: "revision_conflict", task }), {
    status,
    headers: { "content-type": "application/json" },
  });

it("does not miss a file revision changed around initial subscription", async () => {
  vi.useFakeTimers();
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  await transport.read();
  const listener = vi.fn();

  const unsubscribe = transport.subscribe(listener);
  task = { ...task, taskRevision: 1 };
  await vi.runOnlyPendingTimersAsync();

  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskRevision: 1 }));
  expect(fetch).toHaveBeenCalledWith(
    "/__agent-annotations/task",
    expect.objectContaining({
      cache: "no-store",
      headers: expect.objectContaining({ "cache-control": "no-cache" }),
    })
  );
  unsubscribe();
});

it("throws a typed RevisionConflictError with the latest task on every 409", async () => {
  const latest = taskFixture({ taskRevision: 3 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(latest, 409)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const request = {
    taskId: latest.taskId,
    expectedRevision: 2,
    operations: [{ op: "complete" as const, annotationId: "ann-1" }],
  };
  const mutateError = await transport.mutate(request).catch((error: unknown) => error);
  expect(mutateError).toBeInstanceOf(RevisionConflictError);
  expect((mutateError as RevisionConflictError).latestTask.taskRevision).toBe(3);
  expect((mutateError as RevisionConflictError).expectedRevision).toBe(2);
  expect((mutateError as RevisionConflictError).actualRevision).toBe(3);
  const evidenceError = await transport.writeEvidence({
    taskId: latest.taskId,
    expectedRevision: 2,
    annotationId: "ann-1",
    png: "fake",
    width: 10,
    height: 10,
  }).catch((error: unknown) => error);
  expect(evidenceError).toBeInstanceOf(RevisionConflictError);
  expect((evidenceError as RevisionConflictError).expectedRevision).toBe(2);
});

it("never delivers a stale revision from a late poll", async () => {
  vi.useFakeTimers();
  let task = taskFixture({ taskRevision: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 50 });
  const listener = vi.fn();
  transport.subscribe(listener);
  await vi.runOnlyPendingTimersAsync();
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskRevision: 1 }));
  listener.mockClear();
  task = { ...task, taskRevision: 0 };
  await vi.runOnlyPendingTimersAsync();
  expect(listener).not.toHaveBeenCalled();
});

it("keeps at most one poll in flight and stops all traffic after unsubscribe", async () => {
  vi.useFakeTimers();
  let inFlight = 0;
  let peak = 0;
  let release!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Response("{}", { status: 200 });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => { release = resolve; });
    inFlight -= 1;
    return stubTaskResponse(taskFixture());
  }));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 50 });
  const unsubscribe = transport.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(1_000);
  expect(peak).toBe(1);
  const callsBefore = vi.mocked(fetch).mock.calls.length;
  unsubscribe();
  release();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  expect(vi.getTimerCount()).toBe(0);
});
