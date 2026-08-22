import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectEvidenceRefs,
  EVIDENCE_GRACE_PERIOD_MS,
  listEvidence,
  pruneOrphanEvidence,
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

const pruneTask = (refs: string[]) => taskFixture({
  annotations: [
    annotationFixture({ annotationId: "prune-ann", evidence: refs.map((ref) => ({ kind: "screenshot" as const, ref })) }),
  ],
});
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

  it("prunes only unreferenced regular files and preserves referenced ones", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "evidence", "orphan.png"), "x");
    writeFileSync(path.join(dir, "evidence", "referenced.png"), "y");
    // Backdate the orphan so it is outside the grace window.
    const orphan = path.join(dir, "evidence", "orphan.png");
    const past = new Date(Date.now() - EVIDENCE_GRACE_PERIOD_MS - 5_000);
    utimesSync(orphan, past, past);
    const task = evidenceTask(["evidence/referenced.png"]);
    const result = pruneOrphanEvidence(dir, task, 0);
    expect(result.deleted).toEqual(["evidence/orphan.png"]);
    expect(result.errors).toEqual([]);
    expect(existsSync(path.join(dir, "evidence", "orphan.png"))).toBe(false);
    expect(existsSync(path.join(dir, "evidence", "referenced.png"))).toBe(true);
  });

  it("skips recently written evidence inside the grace window", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "evidence", "fresh.png"), "x");
    const result = pruneOrphanEvidence(dir, pruneTask([]), EVIDENCE_GRACE_PERIOD_MS);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(["evidence/fresh.png"]);
    expect(existsSync(path.join(dir, "evidence", "fresh.png"))).toBe(true);
  });

  it("never follows or deletes symlinks and never touches directories", () => {
    const dir = fixture();
    const outside = path.join(dir, "outside.png");
    writeFileSync(outside, "secret");
    symlinkSync(outside, path.join(dir, "evidence", "link.png"));
    mkdirSync(path.join(dir, "evidence", "nested"), { recursive: true });
    writeFileSync(path.join(dir, "evidence", "nested", "inner.png"), "x");
    const result = pruneOrphanEvidence(dir, pruneTask([]), 0);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(["evidence/link.png", "evidence/nested"]);
    expect(existsSync(path.join(dir, "evidence", "link.png"))).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(path.join(dir, "evidence", "nested", "inner.png"))).toBe(true);
  });

  it("returns stable refs regardless of file creation order", () => {
    const dir = fixture();
    // Create b first, then a: the prune output must be sorted by name.
    writeFileSync(path.join(dir, "evidence", "b.png"), "x");
    writeFileSync(path.join(dir, "evidence", "a.png"), "x");
    const past = new Date(Date.now() - EVIDENCE_GRACE_PERIOD_MS - 5_000);
    for (const name of ["a.png", "b.png"]) {
      const file = path.join(dir, "evidence", name);
      utimesSync(file, past, past);
    }
    const result = pruneOrphanEvidence(dir, pruneTask([]), 0);
    expect(result.deleted).toEqual(["evidence/a.png", "evidence/b.png"]);
  });

  it("refuses to sweep a symlinked evidence root", () => {
    const dir = fixture();
    rmSync(path.join(dir, "evidence"), { recursive: true, force: true });
    const outside = path.join(dir, "outside-evidence");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "stray.png"), "x");
    symlinkSync(outside, path.join(dir, "evidence"));
    const result = pruneOrphanEvidence(dir, pruneTask([]), 0);
    expect(result.deleted).toEqual([]);
    expect(existsSync(path.join(outside, "stray.png"))).toBe(true);
  });

  it("rejects Windows drive/backslash refs in every evidence operation", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "evidence", "safe.png"), "x");
    const task = evidenceTask(["evidence/safe.png"]);
    // A Windows-style ref with backslashes must never resolve, list, or delete.
    expect(listEvidence(dir, task).map((entry) => entry.ref)).toEqual(["evidence/safe.png"]);
    expect(removeEvidenceRefs(dir, ["evidence\\outside.png", "C:\\outside.png"])).toEqual([]);
    const result = pruneOrphanEvidence(dir, task, 0);
    expect(result.deleted).toEqual([]);
    expect(existsSync(path.join(dir, "evidence", "safe.png"))).toBe(true);
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
