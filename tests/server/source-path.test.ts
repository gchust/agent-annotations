import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createSourcePathService } from "../../src/server/source-path.js";
import { taskFixture } from "../core/test-data.js";

const roots: string[] = [];
const fixture = () => {
  const parent = mkdtempSync(path.join(tmpdir(), "agent-annotations-source-"));
  roots.push(parent);
  const root = path.join(parent, "workspace");
  mkdirSync(path.join(root, "src", "a"), { recursive: true });
  mkdirSync(path.join(root, "src", "b"), { recursive: true });
  mkdirSync(path.join(root, "other"), { recursive: true });
  writeFileSync(path.join(root, "src", "a", "Card.tsx"), "export const A = 1;\n");
  writeFileSync(path.join(root, "src", "b", "Card.tsx"), "export const B = 1;\n");
  writeFileSync(path.join(root, "other", "Card.tsx"), "export const Other = 1;\n");
  return { parent, root, source: createSourcePathService(root) };
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("source path integrity", () => {
  it("returns null when no referenced source files resolve", () => {
    const { source } = fixture();
    expect(source.files(taskFixture({ annotations: [] }))).toEqual([]);
    expect(source.revision(taskFixture({ annotations: [] }))).toBeNull();
  });

  it("canonicalizes every supported transport form without basename guessing", () => {
    const { root, source } = fixture();
    const absolute = path.join(root, "src", "a", "Card.tsx");
    expect(source.canonicalize("src/a/Card.tsx")).toBe("src/a/Card.tsx");
    expect(source.canonicalize("src\\a\\Card.tsx")).toBe("src/a/Card.tsx");
    expect(source.canonicalize(absolute)).toBe("src/a/Card.tsx");
    expect(source.canonicalize(pathToFileURL(absolute).href)).toBe("src/a/Card.tsx");
    expect(source.canonicalize(`/@fs/${absolute}?import#source`)).toBe("src/a/Card.tsx");
    expect(source.canonicalize("/src/a/Card.tsx?v=1#L1")).toBe("src/a/Card.tsx");
    if (process.platform !== "win32") {
      expect(source.canonicalize(`C:${absolute.replaceAll("/", "\\")}`)).toBe("src/a/Card.tsx");
    }
    expect(source.canonicalize("Card.tsx")).toBeNull();
  });

  it("rejects outside, traversal, missing, directory, URL, and symlink escape paths", () => {
    const { parent, root, source } = fixture();
    const outside = path.join(parent, "outside.ts");
    writeFileSync(outside, "outside");
    symlinkSync(outside, path.join(root, "src", "escape.ts"));
    expect(source.canonicalize("../outside.ts")).toBeNull();
    expect(source.canonicalize(outside)).toBeNull();
    expect(source.canonicalize("/other/Card.tsx")).toBeNull();
    expect(source.canonicalize("src/missing.ts")).toBeNull();
    expect(source.canonicalize("src/a")).toBeNull();
    expect(source.canonicalize("https://example.test/src/a/Card.tsx")).toBeNull();
    expect(source.canonicalize("src/escape.ts")).toBeNull();
  });

  it("keeps duplicate basenames distinct and revisions bound to exact canonical files", () => {
    const { root, source } = fixture();
    expect(source.canonicalize("src/a/Card.tsx")).toBe("src/a/Card.tsx");
    expect(source.canonicalize("src/b/Card.tsx")).toBe("src/b/Card.tsx");
    const task = taskFixture({
      annotations: [{
        ...taskFixture().annotations[0]!,
        targets: [{
          ...taskFixture().annotations[0]!.targets![0]!,
          inspection: {
            ...taskFixture().annotations[0]!.targets![0]!.inspection,
            source: { filePath: "src/a/Card.tsx", lineNumber: 1, columnNumber: 14, componentName: "A" },
            sourceStack: [],
          },
        }],
      }],
    });
    const initial = source.revision(task);
    writeFileSync(path.join(root, "src", "b", "Card.tsx"), "export const B = 2;\n");
    expect(source.revision(task)).toBe(initial);
    writeFileSync(path.join(root, "src", "a", "Card.tsx"), "export const A = 2;\n");
    expect(source.revision(task)).not.toBe(initial);
  });

  it("includes region-only target sources in the revision", () => {
    const { root, source } = fixture();
    const regionOnly = path.join(root, "src", "a", "RegionOnly.tsx");
    writeFileSync(regionOnly, "export const RegionOnly = 1;\n");
    const task = taskFixture({
      annotations: [{
        ...taskFixture().annotations[0]!,
        kind: "region",
        targets: [{
          ...taskFixture().annotations[0]!.targets![0]!,
          inspection: {
            ...taskFixture().annotations[0]!.targets![0]!.inspection,
            source: {
              filePath: "src/a/RegionOnly.tsx",
              lineNumber: 1,
              columnNumber: 14,
              componentName: "RegionOnly",
            },
            sourceStack: [],
          },
        }],
        region: {
          coordinateSpace: "document",
          x: 1,
          y: 2,
          width: 300,
          height: 100,
        },
      }],
    });
    const initial = source.revision(task);
    writeFileSync(regionOnly, "export const RegionOnly = 2;\n");
    expect(source.revision(task)).not.toBe(initial);
  });

  it("turns unresolved persisted frames into null or removes them from the stack", () => {
    const { source } = fixture();
    const annotation = taskFixture().annotations[0]!;
    const canonical = source.canonicalizeAnnotation({
      ...annotation,
      targets: [{
        ...annotation.targets![0]!,
        inspection: {
          ...annotation.targets![0]!.inspection,
          source: { filePath: "Card.tsx", lineNumber: 1, columnNumber: 1, componentName: null },
          sourceStack: [{ filePath: "missing.ts", lineNumber: 1, columnNumber: 1, componentName: null }],
        },
      }],
    });
    expect(canonical.targets![0]!.inspection.source).toBeNull();
    expect(canonical.targets![0]!.inspection.sourceStack).toEqual([]);
  });
});
