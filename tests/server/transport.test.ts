/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";

import { RevisionConflictError } from "../../src/core/index.js";
import { HttpTaskTransport } from "../../src/server/transport.js";
import { taskFixture } from "../core/test-data.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const taskUpdate = () => window.dispatchEvent(new Event("agent-annotations:task-update"));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const stubTaskResponse = (task: unknown, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { task } : { error: "revision_conflict", task }), {
    status,
    headers: { "content-type": "application/json" },
  });

it("requests a task only after a task-update event", async () => {
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  await transport.read();
  const listener = vi.fn();

  const unsubscribe = transport.subscribe(listener);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  task = { ...task, taskRevision: 1 };
  taskUpdate();

  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskRevision: 1 })));
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

it("never delivers a stale revision from a task-update event", async () => {
  let task = taskFixture({ taskRevision: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  taskUpdate();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskRevision: 1 })));
  listener.mockClear();
  task = { ...task, taskRevision: 0 };
  taskUpdate();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("coalesces task-update bursts and stops all traffic after unsubscribe", async () => {
  let inFlight = 0;
  let peak = 0;
  const requests: Array<ReturnType<typeof deferred<Response>>> = [];
  vi.stubGlobal("fetch", vi.fn((_url: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const request = deferred<Response>();
    requests.push(request);
    return request.promise.finally(() => { inFlight -= 1; });
  }));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  taskUpdate();
  taskUpdate();
  taskUpdate();
  expect(requests).toHaveLength(1);
  expect(peak).toBe(1);
  requests[0]!.resolve(stubTaskResponse(taskFixture({ taskRevision: 1 })));
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(peak).toBe(1);
  requests[1]!.resolve(stubTaskResponse(taskFixture({ taskRevision: 2 })));
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  unsubscribe();
  taskUpdate();
  await Promise.resolve();
  expect(requests).toHaveLength(2);
});

it("switches to a new task id at revision 0 and ignores older revisions of the same task", async () => {
  let task = taskFixture({ taskId: "task-a", taskRevision: 12 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  taskUpdate();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-a", taskRevision: 12 }));
  listener.mockClear();
  // The same task id with an older revision is ignored.
  task = { ...task, taskId: "task-a", taskRevision: 10 };
  taskUpdate();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(listener).not.toHaveBeenCalled();
  // A replacement task id arrives with revision 0 and must replace task-a@12.
  task = { ...task, taskId: "task-b", taskRevision: 0 };
  taskUpdate();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-b", taskRevision: 0 })));
  listener.mockClear();
  // The same replacement at an equal revision is ignored.
  task = { ...task, taskId: "task-b", taskRevision: 0 };
  taskUpdate();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("does not re-deliver the revision returned by a successful mutation", async () => {
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  taskUpdate();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
  task = { ...task, taskRevision: 1 };
  await transport.mutate({
    taskId: task.taskId,
    expectedRevision: 0,
    operations: [{ op: "removeCompleted" }],
  });
  taskUpdate();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("records the evidence result as last-seen so the next event is not re-delivered", async () => {
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  taskUpdate();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
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
  taskUpdate();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("only refreshes tasks and aborts the in-flight request on unsubscribe", async () => {
  const signals: AbortSignal[] = [];
  const urls: string[] = [];
  let release!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    signals.push(init?.signal as AbortSignal);
    await new Promise<void>((resolve) => { release = resolve; });
    return stubTaskResponse(taskFixture());
  }));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const unsubscribe = transport.subscribe(vi.fn());
  taskUpdate();
  expect(signals).toHaveLength(1);
  expect(urls.every((url) => url.endsWith("/task"))).toBe(true);
  unsubscribe();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  release();
  await Promise.resolve();
  taskUpdate();
  await Promise.resolve();
  expect(vi.mocked(fetch).mock.calls.length).toBe(signals.length);
});

it("never delivers an invalid task from a task-update event", async () => {
  const task: unknown = { invalid: true };
  vi.stubGlobal("fetch", vi.fn(async () => stubTaskResponse(task)));
  const transport = new HttpTaskTransport({ endpoint: "/__agent-annotations", token: "test" });
  const listener = vi.fn();
  const unsubscribe = transport.subscribe(listener);
  taskUpdate();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
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
