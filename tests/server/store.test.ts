import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RevisionConflictError } from "../../src/core/index.js";
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
    const session = {
      endpoint: "/__agent-annotations",
      origin: "http://127.0.0.1:5173",
      pid: 1,
      startedAt: new Date().toISOString(),
      token: "secret",
      workspaceRoot: root(),
      runtimeRoot: root(),
    };
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
    const task = await store.readOrCreate();
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
    const task = await store.readOrCreate();
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
    const task = await store.readOrCreate();
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
    const task = await store.readOrCreate();
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

  it("creates one task across racing stale-lock recoveries in separate processes", async () => {
    const dir = root();
    const store = new FileTaskStore(dir);
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      child.on("exit", () => resolve(child.pid!));
    });
    const tasksDir = path.join(dir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(path.join(tasksDir, ".write.lock"), JSON.stringify({
      pid: deadPid,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      owner: "stale-owner",
    }));
    const goFile = path.join(tasksDir, ".go");
    const script = [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `import { FileTaskStore } from ${JSON.stringify(path.resolve("dist/vite/index.mjs"))};`,
      `const store = new FileTaskStore(${JSON.stringify(dir)});`,
      `writeFileSync(${JSON.stringify(path.join(tasksDir, ".ready."))} + process.pid, "ready");`,
      `while (!existsSync(${JSON.stringify(goFile)})) {`,
      `  await new Promise((resolve) => setTimeout(resolve, 1));`,
      `}`,
      `const task = await store.readOrCreate();`,
      `process.stdout.write(JSON.stringify({ taskId: task.taskId, revision: task.taskRevision }), () => process.exit(0));`,
    ].join("\n");
    const children = Array.from({ length: 48 }, () => spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] }
    ));
    // Wait for every child to signal readiness, then release them together.
    const readyDeadline = Date.now() + 15_000;
    while (readdirSync(tasksDir).filter((name) => name.startsWith(".ready.")).length < children.length) {
      if (Date.now() > readyDeadline) throw new Error("children did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(goFile, "go");
    const outputs = await Promise.all(children.map((child) => new Promise<string>((resolve) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => { buffer += String(chunk); });
      child.on("close", () => resolve(buffer));
    })));
    const ids = new Set(outputs.map((output) => JSON.parse(output).taskId as string));
    expect(ids.size).toBe(1);
    expect(store.read()!.taskId).toBe([...ids][0]);
  }, 30_000);

  it("throws a typed revision conflict carrying the latest task and revisions", async () => {
    const store = new FileTaskStore(root());
    const task = await store.readOrCreate();
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const conflict = await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture({ annotationId: "ann-2" }) }],
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(RevisionConflictError);
    expect((conflict as RevisionConflictError).code).toBe("revision_conflict");
    expect((conflict as RevisionConflictError).expectedRevision).toBe(0);
    expect((conflict as RevisionConflictError).actualRevision).toBe(1);
    expect((conflict as RevisionConflictError).latestTask.taskRevision).toBe(1);
    expect((conflict as RevisionConflictError).latestTask.annotations[0]?.annotationId).toBe("ann-1");
  });

  it("creates one task across concurrent first reads", async () => {
    const dir = root();
    const stores = Array.from({ length: 4 }, () => new FileTaskStore(dir));
    const tasks = await Promise.all(stores.map((store) => store.readOrCreate()));
    const ids = new Set(tasks.map((created) => created.taskId));
    expect(ids.size).toBe(1);
    expect(stores[0]!.read()!.taskId).toBe(tasks[0]!.taskId);
  });

  it("recovers a stale lock despite an orphaned claim from a different inode", async () => {
    const store = new FileTaskStore(root(), 500);
    const task = await store.readOrCreate();
    const tasksDir = path.join(store.root, "tasks");
    // An orphaned claim: a hard link whose source inode is no longer the lock path.
    const orphanSource = path.join(tasksDir, "orphan-source");
    writeFileSync(orphanSource, "old-claim-target");
    linkSync(orphanSource, path.join(tasksDir, ".write.lock.claim"));
    rmSync(orphanSource);
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      child.on("exit", () => resolve(child.pid!));
    });
    writeFileSync(path.join(tasksDir, ".write.lock"), JSON.stringify({
      pid: deadPid,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      owner: "stale-owner",
    }));
    const next = await store.mutate({
      taskId: task.taskId,
      expectedRevision: task.taskRevision,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    expect(next.taskRevision).toBe(task.taskRevision + 1);
    expect(existsSync(path.join(tasksDir, ".write.lock.claim"))).toBe(false);
  });

  it("never breaks a live lock and recovers only stale dead locks", async () => {
    const store = new FileTaskStore(root(), 100);
    const task = await store.readOrCreate();
    const lockPath = path.join(store.root, "tasks", ".write.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      createdAt: new Date(0).toISOString(),
      owner: "live-owner",
    }));
    await expect(store.mutate({
      taskId: task.taskId,
      expectedRevision: task.taskRevision,
      operations: [{ op: "add", annotation: annotationFixture() }],
    })).rejects.toMatchObject({ code: "write_busy" });
    expect(existsSync(lockPath)).toBe(true);

    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      child.on("exit", () => resolve(child.pid!));
    });
    // A fresh dead lock still reports busy and is not deleted.
    writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      createdAt: new Date().toISOString(),
      owner: "dead-owner",
    }));
    await expect(store.mutate({
      taskId: task.taskId,
      expectedRevision: task.taskRevision,
      operations: [{ op: "add", annotation: annotationFixture() }],
    })).rejects.toMatchObject({ code: "write_busy" });
    expect(existsSync(lockPath)).toBe(true);

    // A stale dead lock (old createdAt) is conservatively recovered.
    writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      owner: "dead-owner",
    }));
    const next = await store.mutate({
      taskId: task.taskId,
      expectedRevision: task.taskRevision,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    expect(next.taskRevision).toBe(task.taskRevision + 1);
  });

  it("conservatively recovers only stale malformed or incomplete locks", async () => {
    const store = new FileTaskStore(root(), 100);
    const task = await store.readOrCreate();
    const lockPath = path.join(store.root, "tasks", ".write.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    for (const [index, content] of ["not-json", JSON.stringify({ pid: process.pid })].entries()) {
      writeFileSync(lockPath, content);
      const current = store.read()!;
      await expect(store.mutate({
        taskId: current.taskId,
        expectedRevision: current.taskRevision,
        operations: [{ op: "add", annotation: annotationFixture({ annotationId: `lock-${index}` }) }],
      })).rejects.toMatchObject({ code: "write_busy" });
      expect(existsSync(lockPath)).toBe(true);

      const backdated = new Date(Date.now() - 60_000);
      utimesSync(lockPath, backdated, backdated);
      const before = store.read()!;
      const next = await store.mutate({
        taskId: before.taskId,
        expectedRevision: before.taskRevision,
        operations: [{ op: "add", annotation: annotationFixture({ annotationId: `lock-${index}` }) }],
      });
      expect(next.taskRevision).toBe(before.taskRevision + 1);
    }
  });

  it("keeps evidence paths contained for malicious annotation ids", async () => {
    const store = new FileTaskStore(root());
    const task = await store.readOrCreate();
    await expect(store.writeEvidence(
      { taskId: task.taskId, expectedRevision: 0, operations: [] },
      { annotationId: "../../escape", bytes: Buffer.from("89504e470d0a1a0a00000000", "hex"), mediaType: "image/png" }
    )).rejects.toThrow("invalid_annotation_id");
    expect(existsSync(path.join(store.root, "escape-"))).toBe(false);
  });

  it("deletes orphan evidence after remove and remove-completed", async () => {
    const store = new FileTaskStore(root());
    const task = await store.readOrCreate();
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
    const task = await store.readOrCreate();
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
    const task = await store.readOrCreate();
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

  it("persists create through the same redaction boundary and returns the written task", async () => {
    const store = new FileTaskStore(root());
    const created = await store.create();
    expect(JSON.parse(readFileSync(store.taskPath, "utf8"))).toEqual(created);
    expect(store.read()).toEqual(created);
  });

  it("redacts secrets from addEvidence metadata refs before persistence", async () => {
    const store = new FileTaskStore(root());
    const task = await store.readOrCreate();
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
    const task = await store.readOrCreate();
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
