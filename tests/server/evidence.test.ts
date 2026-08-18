import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectEvidenceRefs,
  listEvidence,
  removeEvidenceRefs,
} from "../../src/server/evidence.js";
import { annotationFixture, taskFixture } from "../core/test-data.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-evidence-"));
  roots.push(root);
  mkdirSync(path.join(root, "evidence"), { recursive: true });
  return root;
};

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

const evidenceTask = (refs: string[]) => taskFixture({
  annotations: [
    annotationFixture({
      annotationId: "ann-1",
      evidence: refs.map((ref) => ({ kind: "screenshot" as const, ref })),
    }),
  ],
});

describe("evidence lifecycle", () => {
  it("lists only task-referenced contained files with annotation metadata", () => {
    const root = fixture();
    writeFileSync(path.join(root, "evidence", "ann-1-a.png"), "a");
    writeFileSync(path.join(root, "evidence", "ann-1-b.png"), "bb");
    writeFileSync(path.join(root, "evidence", "orphan.png"), "orphan");
    const entries = listEvidence(root, evidenceTask(["evidence/ann-1-a.png", "evidence/ann-1-b.png"]));
    expect(entries.map(({ ref }) => ref)).toEqual(["evidence/ann-1-a.png", "evidence/ann-1-b.png"]);
    expect(entries[0]).toMatchObject({ size: 1, annotationIds: ["ann-1"] });
  });

  it("collects the referenced refs of a task", () => {
    const refs = collectEvidenceRefs(evidenceTask(["evidence/a.png", "evidence/b.png"]));
    expect([...refs]).toEqual(["evidence/a.png", "evidence/b.png"]);
  });

  it("deletes only the given lost-reference candidates that are safely contained", () => {
    const root = fixture();
    writeFileSync(path.join(root, "evidence", "lost.png"), "lost");
    writeFileSync(path.join(root, "evidence", "kept.png"), "kept");
    const removed = removeEvidenceRefs(root, ["evidence/lost.png"]);
    expect(removed).toEqual(["evidence/lost.png"]);
    expect(existsSync(path.join(root, "evidence", "lost.png"))).toBe(false);
    expect(existsSync(path.join(root, "evidence", "kept.png"))).toBe(true);
  });

  it("rejects contained traversal refs in both list and delete", () => {
    const root = fixture();
    writeFileSync(path.join(root, "evidence", "real.png"), "real");
    const task = evidenceTask(["evidence/sub/../real.png", "evidence/./real.png"]);
    expect(listEvidence(root, task)).toEqual([]);
    const removed = removeEvidenceRefs(root, ["evidence/sub/../real.png", "evidence/./real.png"]);
    expect(removed).toEqual([]);
    expect(existsSync(path.join(root, "evidence", "real.png"))).toBe(true);
  });

  it("never deletes traversal, symlink, or outside candidate refs", () => {
    const root = fixture();
    const outside = path.join(root, "outside.png");
    writeFileSync(outside, "outside");
    symlinkSync(outside, path.join(root, "evidence", "linked.png"));
    writeFileSync(path.join(root, "evidence", "real.png"), "real");
    const removed = removeEvidenceRefs(root, [
      "evidence/real.png",
      "evidence/linked.png",
      "../outside.png",
      "/absolute.png",
      "evidence/../outside.png",
    ]);
    expect(removed).toEqual(["evidence/real.png"]);
    expect(existsSync(path.join(root, "outside.png"))).toBe(true);
    expect(existsSync(path.join(root, "evidence", "linked.png"))).toBe(true);
    expect(existsSync(path.join(root, "evidence", "real.png"))).toBe(false);
  });
});
