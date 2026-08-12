import { describe, expect, it } from "vitest";

import {
  ClientExtensionRegistry,
  defineClientExtension,
  type AgentFeedbackClientExtension,
} from "../../src/extension/index.js";

const action = (
  id: string,
  key = id[0].toUpperCase()
): NonNullable<AgentFeedbackClientExtension["toolbar"]>[number] => ({
  id,
  group: "capture",
  label: id,
  kind: "action",
  shortcut: { key, code: `Key${key}`, primary: true, alt: true, shift: false },
});

const extension = (
  id: string,
  toolbar: NonNullable<AgentFeedbackClientExtension["toolbar"]> = []
) => defineClientExtension({ id, apiVersion: 1, toolbar });

describe("ClientExtensionRegistry", () => {
  it("registers, sorts, and unregisters contributions", () => {
    const registry = new ClientExtensionRegistry();
    const dispose = registry.register(extension("demo", [
      { ...action("late", "L"), order: 20 },
      { ...action("first", "F"), order: 10 },
    ]));

    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["demo"]);
    expect(registry.getToolbarContributions().map(({ id }) => id)).toEqual(["first", "late"]);
    dispose();
    dispose();
    expect(registry.getExtensions()).toEqual([]);
    expect(registry.getToolbarContributions()).toEqual([]);
  });

  it("rejects duplicate extension and contribution IDs deterministically", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", [action("copy", "C")]));

    expect(() => registry.register(extension("one"))).toThrow("Duplicate extension ID: one");
    expect(() => registry.register(extension("two", [action("copy", "J")])))
      .toThrow("Duplicate toolbar contribution ID: copy");
  });

  it("rejects duplicate key and code shortcuts", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", [action("copy", "C")]));

    expect(() => registry.register(extension("two", [action("clone", "c")])))
      .toThrow("Duplicate toolbar shortcut: clone conflicts with copy");
    expect(() => registry.register(extension("three", [{
      ...action("symbol", "X"),
      shortcut: { key: "χ", code: "KeyC", primary: true, alt: true, shift: false },
    }])))
      .toThrow("Duplicate toolbar shortcut: symbol conflicts with copy");
  });

  it("validates an extension atomically", () => {
    const registry = new ClientExtensionRegistry();
    const invalid = extension("broken", [
      action("valid", "V"),
      { ...action("invalid", "I"), group: "wrong" as "capture" },
    ]);

    expect(() => registry.register(invalid)).toThrow("Invalid toolbar group: wrong");
    expect(registry.getExtensions()).toEqual([]);
    expect(registry.getToolbarContributions()).toEqual([]);
    expect(() => registry.register(extension("working", [action("valid", "V")]))).not.toThrow();
  });

  it("does not partially register duplicate contributions within one extension", () => {
    const registry = new ClientExtensionRegistry();
    expect(() => registry.register(extension("broken", [
      action("same", "S"),
      action("same", "D"),
    ]))).toThrow("Duplicate toolbar contribution ID: same");

    expect(registry.getExtensions()).toEqual([]);
    expect(() => registry.register(extension("working", [action("same", "S")]))).not.toThrow();
  });
});
