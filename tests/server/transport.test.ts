/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";

import { HttpTaskTransport } from "../../src/server/transport.js";
import { taskFixture } from "../core/test-data.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not miss a file revision changed around initial subscription", async () => {
  vi.useFakeTimers();
  let task = taskFixture({ taskRevision: 0 });
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ task }), {
      headers: { "content-type": "application/json" },
    })
  ));
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
