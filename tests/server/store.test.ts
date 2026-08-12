import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileTaskStore } from "../../src/server/store.js";
import { annotationFixture } from "../core/test-data.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "agent-feedback-store-"));
  roots.push(value);
  return value;
};

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

describe("file task store", () => {
  it("writes a private session and removes only its own session on close", async () => {
    const store = new FileTaskStore(root());
    const session = { endpoint: "/__agent-feedback", origin: "http://127.0.0.1:5173", pid: 1, startedAt: new Date().toISOString(), token: "secret" };
    store.writeSession(session);
    expect(statSync(store.sessionPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.sessionPath, "utf8"))).toEqual(session);
    await store.close("wrong");
    expect(statSync(store.sessionPath).isFile()).toBe(true);
    store.closeSession("secret");
    expect(() => statSync(store.sessionPath)).toThrow();
  });

  it("atomically serializes writes and rejects stale concurrent revisions", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    const request = {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add" as const, annotation: annotationFixture() }],
    };
    const results = await Promise.allSettled([store.mutate(request), store.mutate(request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason.code).toBe("revision_conflict");
    expect(store.read()).toMatchObject({ taskRevision: 1, annotations: [{ annotationId: "ann-1" }] });
  });

  it("stores bounded PNG evidence and adds its reference through the revision mutation", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    const added = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const evidenced = await store.writeEvidence(
      { taskId: added.taskId, expectedRevision: 1, operations: [] },
      { annotationId: "ann-1", bytes: png, mediaType: "image/png" }
    );
    expect(evidenced).toMatchObject({
      taskRevision: 2,
      annotations: [{ evidence: [{ kind: "screenshot", mediaType: "image/png" }] }],
    });
    const reference = evidenced.annotations[0].evidence?.[0].ref;
    expect(readFileSync(path.join(store.root, reference!))).toEqual(png);
  });
});
