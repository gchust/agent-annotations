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
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
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
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
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

it("rejects poll intervals outside the finite integer range 100..10000", () => {
  const make = (pollInterval: unknown) => () => new HttpTaskTransport({
    endpoint: "/__agent-annotations",
    token: "test",
    pollInterval: pollInterval as number,
  });
  for (const pollInterval of [0, 50, 99, 10001, -1, 1.5, NaN, Infinity, Number.NEGATIVE_INFINITY, "500"]) {
    expect(make(pollInterval)).toThrow(TypeError);
  }
  expect(make(100)().pollInterval).toBe(100);
  expect(make(10_000)().pollInterval).toBe(10_000);
  expect(new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" }).pollInterval).toBe(500);
});

it("switches to a new task id at revision 0 and ignores older revisions of the same task", async () => {
  vi.useFakeTimers();
  let task = taskFixture({ taskId: "task-a", taskRevision: 12 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  await vi.runOnlyPendingTimersAsync();
  expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-a", taskRevision: 12 }));
  listener.mockClear();
  // The same task id with an older revision is ignored.
  task = { ...task, taskId: "task-a", taskRevision: 10 };
  await vi.runOnlyPendingTimersAsync();
  expect(listener).not.toHaveBeenCalled();
  // A replacement task id arrives with revision 0 and must replace task-a@12.
  task = { ...task, taskId: "task-b", taskRevision: 0 };
  await vi.runOnlyPendingTimersAsync();
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-b", taskRevision: 0 }));
  listener.mockClear();
  // The same replacement at an equal revision is ignored.
  task = { ...task, taskId: "task-b", taskRevision: 0 };
  await vi.runOnlyPendingTimersAsync();
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("does not re-deliver the revision returned by a successful mutation", async () => {
  vi.useFakeTimers();
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  await vi.runOnlyPendingTimersAsync();
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
  task = { ...task, taskRevision: 1 };
  await transport.mutate({
    taskId: task.taskId,
    expectedRevision: 0,
    operations: [{ op: "removeCompleted" }],
  });
  await vi.runOnlyPendingTimersAsync();
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("records the evidence result as last-seen so the next poll is not re-delivered", async () => {
  vi.useFakeTimers();
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  await vi.runOnlyPendingTimersAsync();
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
  task = { ...task, taskRevision: 2 };
  await transport.writeEvidence({
    taskId: task.taskId,
    expectedRevision: 1,
    annotationId: "ann-1",
    png: "fake",
    width: 10,
    height: 10,
  });
  await vi.runOnlyPendingTimersAsync();
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("only polls tasks and aborts the in-flight poll on unsubscribe", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const urls: string[] = [];
  let release!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    signals.push(init?.signal as AbortSignal);
    await new Promise<void>((resolve) => { release = resolve; });
    return stubTaskResponse(taskFixture());
  }));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
  const unsubscribe = transport.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  expect(signals.length).toBeGreaterThan(0);
  expect(urls.every((url) => url.endsWith("/task"))).toBe(true);
  unsubscribe();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(vi.mocked(fetch).mock.calls.length).toBe(signals.length);
});

it("never delivers an invalid task from a poll", async () => {
  vi.useFakeTimers();
  let task: unknown = { invalid: true };
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test", pollInterval: 100 });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  await vi.advanceTimersByTimeAsync(500);
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a locatable validation error when a 409 carries an invalid task", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    error: "revision_conflict",
    task: { invalid: true },
  }), { status: 409, headers: { "content-type": "application/json" } })));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const mutateError = await transport.mutate({
    taskId: "task-1",
    expectedRevision: 1,
    operations: [{ op: "removeCompleted" }],
  }).catch((error: unknown) => error);
  expect(mutateError).not.toBeInstanceOf(RevisionConflictError);
  expect(mutateError).toBeInstanceOf(Error);
  expect((mutateError as Error).message).toContain("conflict");
  expect((mutateError as Error).message).not.toBe("revision_conflict");
  const evidenceError = await transport.writeEvidence({
    taskId: "task-1",
    expectedRevision: 1,
    annotationId: "ann-1",
    png: "fake",
    width: 10,
    height: 10,
  }).catch((error: unknown) => error);
  expect((evidenceError as Error).message).toContain("conflict");
});
