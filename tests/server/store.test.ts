import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileTaskStore } from "../../src/server/store.js";
import { annotationFixture } from "../core/test-data.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "agent-annotations-store-"));
  roots.push(value);
  return value;
};

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

describe("file task store", () => {
  it("writes a private session and removes only its own session on close", async () => {
    const store = new FileTaskStore(root());
    const session = { endpoint: "/__agent-annotations", origin: "http://127.0.0.1:5173", pid: 1, startedAt: new Date().toISOString(), token: "secret" };
    store.writeSession(session);
    expect(statSync(store.sessionPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.sessionPath, "utf8"))).toEqual(session);
    await store.close("wrong");
    expect(statSync(store.sessionPath).isFile()).toBe(true);
    store.closeSync("secret");
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
      { annotationId: "ann-1", bytes: png, mediaType: "image/png", width: 1600, height: 900 }
    );
    expect(evidenced).toMatchObject({
      taskRevision: 2,
      annotations: [{ evidence: [{ kind: "screenshot", mediaType: "image/png", width: 1600, height: 900 }] }],
    });
    const reference = evidenced.annotations[0].evidence?.[0].ref;
    expect(readFileSync(path.join(store.root, reference!))).toEqual(png);
  });

  it("keeps unrelated evidence files during ordinary mutations", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    mkdirSync(path.join(store.root, "evidence"), { recursive: true });
    writeFileSync(path.join(store.root, "evidence", "unrelated.png"), "x");
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    expect(existsSync(path.join(store.root, "evidence", "unrelated.png"))).toBe(true);
  });

  it("preserves a shared evidence ref while any annotation still references it", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    const added = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const shared = await store.mutate({
      taskId: added.taskId,
      expectedRevision: 1,
      operations: [
        { op: "add", annotation: annotationFixture({ annotationId: "ann-2" }) },
        { op: "addEvidence", annotationId: "ann-1", evidence: { kind: "screenshot", ref: "evidence/shared.png", mediaType: "image/png" } },
        { op: "addEvidence", annotationId: "ann-2", evidence: { kind: "screenshot", ref: "evidence/shared.png", mediaType: "image/png" } },
      ],
    });
    mkdirSync(path.join(store.root, "evidence"), { recursive: true });
    writeFileSync(path.join(store.root, "evidence", "shared.png"), "png");
    await store.mutate({
      taskId: shared.taskId,
      expectedRevision: 2,
      operations: [{ op: "remove", annotationId: "ann-1" }],
    });
    expect(existsSync(path.join(store.root, "evidence", "shared.png"))).toBe(true);
    await store.mutate({
      taskId: shared.taskId,
      expectedRevision: 3,
      operations: [{ op: "remove", annotationId: "ann-2" }],
    });
    expect(existsSync(path.join(store.root, "evidence", "shared.png"))).toBe(false);
  });

  it("deletes orphan evidence after remove and remove-completed", async () => {
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
      { annotationId: "ann-1", bytes: png, mediaType: "image/png", width: 1600, height: 900 }
    );
    const reference = evidenced.annotations[0].evidence?.[0].ref!;
    expect(existsSync(path.join(store.root, reference))).toBe(true);
    await store.mutate({
      taskId: added.taskId,
      expectedRevision: 2,
      operations: [{ op: "remove", annotationId: "ann-1" }],
    });
    expect(existsSync(path.join(store.root, reference))).toBe(false);

    const second = await store.mutate({
      taskId: added.taskId,
      expectedRevision: 3,
      operations: [{ op: "add", annotation: annotationFixture({ annotationId: "ann-2" }) }],
    });
    const evidenced2 = await store.writeEvidence(
      { taskId: second.taskId, expectedRevision: 4, operations: [] },
      { annotationId: "ann-2", bytes: png, mediaType: "image/png", width: 1600, height: 900 }
    );
    const reference2 = evidenced2.annotations[0].evidence?.[0].ref!;
    await store.mutate({
      taskId: second.taskId,
      expectedRevision: 5,
      operations: [{ op: "complete", annotationId: "ann-2" }],
    });
    await store.mutate({
      taskId: second.taskId,
      expectedRevision: 6,
      operations: [{ op: "removeCompleted" }],
    });
    expect(existsSync(path.join(store.root, reference2))).toBe(false);
  });

  it("redacts secrets from update comments before persistence", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const updated = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 1,
      operations: [{
        op: "update",
        annotationId: "ann-1",
        comment: "Bearer UNIQUE_SECRET_SENTINEL_update",
      }],
    });
    expect(updated.annotations[0].comment).not.toContain("UNIQUE_SECRET_SENTINEL_update");
    expect(updated.annotations[0].comment).toContain("[REDACTED]");
    expect(JSON.stringify(store.read())).not.toContain("UNIQUE_SECRET_SENTINEL_update");
  });

  it("redacts secrets from setExtension data before persistence", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const updated = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 1,
      operations: [{
        op: "setExtension",
        annotationId: "ann-1",
        extensionId: "demo.extension",
        data: {
          token: "Bearer UNIQUE_SECRET_SENTINEL_set",
          keep: "Bearer UNIQUE_SECRET_SENTINEL_keep",
        },
      }],
    });
    const extensions = updated.annotations[0].extensions["demo.extension"];
    expect(extensions).not.toHaveProperty("token");
    expect(JSON.stringify(extensions)).not.toContain("UNIQUE_SECRET_SENTINEL");
    expect(JSON.stringify(store.read())).not.toContain("UNIQUE_SECRET_SENTINEL");
  });

  it("persists create through the same redaction boundary and returns the written task", () => {
    const store = new FileTaskStore(root());
    const created = store.create();
    expect(JSON.parse(readFileSync(store.taskPath, "utf8"))).toEqual(created);
    expect(store.read()).toEqual(created);
  });

  it("redacts secrets from addEvidence metadata refs before persistence", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const evidenced = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 1,
      operations: [{
        op: "addEvidence",
        annotationId: "ann-1",
        evidence: {
          kind: "screenshot",
          ref: "evidence/ann-1.png?token=UNIQUE_SECRET_SENTINEL_ref",
          mediaType: "image/png",
        },
      }],
    });
    expect(evidenced.annotations[0].evidence?.[0].ref).not.toContain("UNIQUE_SECRET_SENTINEL_ref");
    expect(evidenced.annotations[0].evidence?.[0].ref).toContain("[REDACTED]");
    const persisted = readFileSync(store.taskPath, "utf8");
    expect(persisted).not.toContain("UNIQUE_SECRET_SENTINEL_ref");
    expect(persisted).toContain("[REDACTED]");
  });

  it("redacts secrets from completion evidence before persistence", async () => {
    const store = new FileTaskStore(root());
    const task = store.readOrCreate();
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const completed = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 1,
      operations: [{
        op: "complete",
        annotationId: "ann-1",
        evidence: { verified: true, summary: "Bearer UNIQUE_SECRET_SENTINEL_complete", source: "test" },
      }],
    });
    expect(completed.annotations[0].completionEvidence?.summary).not.toContain("UNIQUE_SECRET_SENTINEL_complete");
    expect(completed.annotations[0].completionEvidence?.summary).toContain("[REDACTED]");
    expect(JSON.stringify(store.read())).not.toContain("UNIQUE_SECRET_SENTINEL_complete");
  });
});
