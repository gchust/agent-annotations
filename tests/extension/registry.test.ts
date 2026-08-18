import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ClientExtensionRegistry,
  defineClientExtension,
  registerClientExtension,
  type AgentAnnotationsClientExtension,
  type AnnotationExporter,
  type AnnotationRedactor,
  type HostIntegration,
  type PanelContribution,
  type TargetEnricher,
  type ToolbarContribution,
} from "../../src/extension/index.js";

const action = (id: string, key = id[0].toUpperCase()): ToolbarContribution => ({
  id,
  group: "capture",
  label: id,
  icon: () => null,
  kind: "action",
  execute: () => undefined,
  shortcut: { key, code: `Key${key.toUpperCase()}`, primary: true, alt: true, shift: false },
});
const panel = (id: string): PanelContribution => ({ id, title: id, render: () => null });
const enricher = (id: string): TargetEnricher => ({ id, enrich: () => ({ ready: true }) });
const exporter = (id: string): AnnotationExporter => ({ id, export: () => "{}" });
const redactor = (id: string): AnnotationRedactor => ({ id, redact: (task) => task });
const extension = (
  id: string,
  values: Omit<AgentAnnotationsClientExtension, "id" | "apiVersion"> = {}
) => defineClientExtension({ id, apiVersion: 1, ...values });

describe("ClientExtensionRegistry", () => {
  it("canonicalizes internal ids while preserving local ids in author input", () => {
    const registry = new ClientExtensionRegistry();
    const setup = vi.fn();
    const host: HostIntegration = { locale: () => "en-US" };
    registerClientExtension(registry, extension("z-extension", {
      setup,
      toolbar: [
        { ...action("late", "L"), order: 20 },
        { ...action("host", "H"), group: "host", order: -10 },
        { ...action("first", "F"), order: 10 },
        { ...action("open", "P"), kind: "panel", execute: undefined, panelId: "panel" },
      ],
      panels: [panel("z-panel"), panel("a-panel"), panel("panel")],
      targetEnrichers: [enricher("z-enricher"), enricher("a-enricher")],
      exporters: [exporter("z-exporter"), exporter("a-exporter")],
      redactors: [redactor("z-redactor"), redactor("a-redactor")],
      messages: { z: "last", shared: "z" },
      host,
    }));
    registry.register(extension("a-extension", { messages: { a: "first" } }));

    expect(setup).not.toHaveBeenCalled();
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["a-extension", "z-extension"]);
    expect(registry.getToolbarContributions().map(({ id }) => id)).toEqual([
      "z-extension:open",
      "z-extension:first",
      "z-extension:late",
      "z-extension:host",
    ]);
    const panelOpen = registry.getToolbarContributions().find(({ id }) => id === "z-extension:open")!;
    expect(panelOpen.panelId).toBe("z-extension:panel");
    expect(registry.getPanels().map(({ id }) => id)).toEqual([
      "z-extension:a-panel",
      "z-extension:panel",
      "z-extension:z-panel",
    ]);
    expect(registry.getTargetEnrichers().map(({ id }) => id)).toEqual([
      "z-extension:a-enricher",
      "z-extension:z-enricher",
    ]);
    expect(registry.getExporters().map(({ id }) => id)).toEqual([
      "z-extension:a-exporter",
      "z-extension:z-exporter",
    ]);
    expect(registry.getRedactors().map(({ id }) => id)).toEqual([
      "z-extension:a-redactor",
      "z-extension:z-redactor",
    ]);
    expect(registry.getMessages()).toEqual({ a: "first", z: "last", shared: "z" });
    expect(registry.getHostIntegration()).toBe(host);
  });

  it("lets two extensions register the same local id", () => {
    const registry = new ClientExtensionRegistry();
    const noShortcut = (id: string): ToolbarContribution => ({
      id,
      group: "host",
      label: id,
      icon: () => null,
      kind: "action",
      execute: () => undefined,
    });
    registry.register(extension("one", {
      toolbar: [noShortcut("list")],
      panels: [panel("list")],
      exporters: [exporter("list")],
    }));
    registry.register(extension("two", {
      toolbar: [noShortcut("list")],
      panels: [panel("list")],
      exporters: [exporter("list")],
    }));
    expect(registry.getToolbarContributions().map(({ id }) => id)).toEqual([
      "one:list",
      "two:list",
    ]);
    expect(registry.getPanels().map(({ id }) => id)).toEqual(["one:list", "two:list"]);
    expect(registry.getExporters().map(({ id }) => id)).toEqual(["one:list", "two:list"]);
  });

  it("rejects cross-extension shortcut conflicts with both canonical owners and stays atomic", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", { toolbar: [action("copy", "C")] }));
    expect(() => registry.register(extension("two", {
      toolbar: [{ ...action("clone", "X"), shortcut: { key: "c", code: "KeyX", primary: true, alt: true, shift: false } }],
    }))).toThrow("Duplicate toolbar shortcut: two:clone conflicts with one:copy");
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["one"]);
  });

  it("rejects conflicting locale message keys with both extension ids and stays atomic", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", { messages: { shared: "one" } }));
    expect(() => registry.register(extension("two", { messages: { shared: "two" } })))
      .toThrow("Duplicate locale message key: shared (two conflicts with one)");
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["one"]);
    expect(registry.getMessages()).toEqual({ shared: "one" });
  });

  it("rejects an intra-extension message key defined in both message sources atomically", () => {
    const registry = new ClientExtensionRegistry();
    expect(() => registry.register(extension("broken", {
      messages: { shared: "one" },
      host: { messages: { shared: "two" } },
    }))).toThrow(
      "Duplicate locale message key: shared (broken defines it in both messages and host.messages)"
    );
    expect(registry.getExtensions()).toEqual([]);
    expect(registry.getMessages()).toEqual({});
  });

  it("rejects host message conflicts against any extension message source", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", { host: { messages: { shared: "host-one" } } }));
    expect(() => registry.register(extension("two", { messages: { shared: "two" } })))
      .toThrow("Duplicate locale message key: shared (two conflicts with one)");
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["one"]);
    expect(registry.getMessages()).toEqual({ shared: "host-one" });

    const second = new ClientExtensionRegistry();
    second.register(extension("one", { messages: { shared: "one" } }));
    expect(() => second.register(extension("two", { host: { messages: { shared: "two" } } })))
      .toThrow("Duplicate locale message key: shared (two conflicts with one)");
    expect(second.getExtensions().map(({ id }) => id)).toEqual(["one"]);
  });

  it("rejects an intra-extension duplicate canonical id atomically", () => {
    const registry = new ClientExtensionRegistry();
    expect(() => registry.register(extension("broken", {
      toolbar: [action("same", "A"), action("same", "B")],
    }))).toThrow("Duplicate toolbar contribution ID: broken:same");
    expect(registry.getExtensions()).toEqual([]);
  });

  it("resolves panel references only within the owning extension", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", { panels: [panel("panel")] }));
    // A toolbar in a different extension cannot reference another extension's panel.
    expect(() => registry.register(extension("two", {
      toolbar: [{ ...action("open", "O"), kind: "panel", execute: undefined, panelId: "panel" }],
    }))).toThrow("Unknown toolbar panel ID: two:panel");
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["one"]);
    // The owning extension resolves its own panel deterministically.
    expect(() => registry.register(extension("three", {
      toolbar: [{ ...action("open", "O"), kind: "panel", execute: undefined, panelId: "panel" }],
      panels: [panel("panel")],
    }))).not.toThrow();
    expect(registry.getToolbarContributions().find(({ id }) => id === "three:open")?.panelId)
      .toBe("three:panel");
  });

  it("unregisters all owned entries once and permits re-registration", () => {
    const registry = new ClientExtensionRegistry();
    const complete = extension("complete", {
      toolbar: [action("action", "A")],
      panels: [panel("panel")],
      targetEnrichers: [enricher("enricher")],
      exporters: [exporter("exporter")],
      redactors: [redactor("redactor")],
      messages: { complete: "Complete" },
      host: { routeKey: () => "/complete" },
    });
    const unregister = registry.register(complete);
    unregister();
    unregister();

    expect(registry.getExtensions()).toEqual([]);
    expect(registry.getToolbarContributions()).toEqual([]);
    expect(registry.getPanels()).toEqual([]);
    expect(registry.getTargetEnrichers()).toEqual([]);
    expect(registry.getExporters()).toEqual([]);
    expect(registry.getRedactors()).toEqual([]);
    expect(registry.getMessages()).toEqual({});
    expect(registry.getHostIntegration()).toBeUndefined();
    expect(() => registry.register(complete)).not.toThrow();
  });

  it("rejects duplicate extension ids atomically", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("same"));
    expect(() => registry.register(extension("same"))).toThrow("Duplicate extension ID: same");
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["same"]);
  });

  it("rejects every intra-extension duplicate atomically", () => {
    const families = [
      ["toolbar contribution", { toolbar: [action("same", "A"), action("same", "B")] }],
      ["panel", { panels: [panel("same"), panel("same")] }],
      ["target enricher", { targetEnrichers: [enricher("same"), enricher("same")] }],
      ["exporter", { exporters: [exporter("same"), exporter("same")] }],
      ["redactor", { redactors: [redactor("same"), redactor("same")] }],
    ] as const;
    for (const [kind, values] of families) {
      const registry = new ClientExtensionRegistry();
      expect(() => registry.register(extension("broken", values))).toThrow(`Duplicate ${kind} ID: broken:same`);
      expect(registry.getExtensions()).toEqual([]);
    }
  });

  it("rejects key and code shortcut conflicts, including within one extension", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", { toolbar: [action("copy", "C")] }));
    expect(() => registry.register(extension("two", {
      toolbar: [{ ...action("clone", "X"), shortcut: { key: "c", code: "KeyX", primary: true, alt: true, shift: false } }],
    }))).toThrow("Duplicate toolbar shortcut: two:clone conflicts with one:copy");

    const intra = new ClientExtensionRegistry();
    expect(() => intra.register(extension("broken", { toolbar: [
      action("first", "A"),
      { ...action("second", "B"), shortcut: { key: "a", code: "KeyB", primary: true, alt: true, shift: false } },
    ] }))).toThrow("Duplicate toolbar shortcut: broken:second conflicts with broken:first");
    expect(intra.getExtensions()).toEqual([]);
  });

  it("rejects host and panel-reference conflicts atomically", () => {
    const registry = new ClientExtensionRegistry();
    const host: HostIntegration = { locale: () => "en-US" };
    registry.register(extension("one", { host }));
    expect(() => registry.register(extension("two", { host }))).toThrow("Duplicate host integration: two conflicts with one");
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["one"]);

    const missing = new ClientExtensionRegistry();
    expect(() => missing.register(extension("broken", { toolbar: [{
      ...action("open", "O"), kind: "panel", execute: undefined, panelId: "missing",
    }] }))).toThrow("Unknown toolbar panel ID: broken:missing");
    expect(missing.getExtensions()).toEqual([]);
  });

  it("validates every field before mutating state", () => {
    const invalid = [
      { toolbar: "bad" as never },
      { toolbar: [{ ...action("bad", "A"), icon: "bad" as never }] },
      { toolbar: [{ ...action("bad", "A"), label: {} }] },
      { toolbar: [{ ...action("bad", "A"), group: "bad" as never }] },
      { toolbar: [{ ...action("bad", "A"), kind: "bad" as never }] },
      { toolbar: [{ ...action("bad", "A"), order: Number.NaN }] },
      { toolbar: [{ ...action("bad", "A"), shortcut: { key: "", primary: true, alt: true, shift: false } }] },
      { panels: [{ ...panel("bad"), render: "bad" as never }] },
      { panels: [{ ...panel("bad"), title: "" }] },
      { panels: [{ ...panel("bad"), placement: "bad" as never }] },
      { targetEnrichers: [{ ...enricher("bad"), enrich: "bad" as never }] },
      { exporters: [{ ...exporter("bad"), export: "bad" as never }] },
      { redactors: [{ ...redactor("bad"), redact: "bad" as never }] },
      { messages: { bad: 1 } as never },
      { host: { locale: "bad" } as never },
      { host: { navigate: "bad" } as never },
      { host: { subscribe: "bad" as never } },
      { setup: "bad" as never },
    ];
    for (const [index, values] of invalid.entries()) {
      const registry = new ClientExtensionRegistry();
      expect(() => registry.register(extension(`broken-${index}`, values))).toThrow();
      expect(registry.getExtensions()).toEqual([]);
      expect(registry.getToolbarContributions()).toEqual([]);
    }
  });

  it("accepts host route navigate and subscribe callbacks", () => {
    const registry = new ClientExtensionRegistry();
    const navigate = () => undefined;
    const subscribe = () => () => undefined;
    expect(() => registry.register(extension("route-host", {
      host: { routeKey: () => "/a", navigate, subscribe },
    }))).not.toThrow();
    expect(registry.getHostIntegration()).toMatchObject({ navigate, subscribe });
  });

  it("preserves defineClientExtension identity", () => {
    const value = { id: "identity", apiVersion: 1 } as const;
    expect(defineClientExtension(value)).toBe(value);
  });

  it("keeps exclusiveGroup out of public types and docs", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    for (const file of ["src/types/index.ts", "src/client/builtin-extension.ts", "README.md", "API.md"]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toContain("exclusiveGroup");
    }
  });
});
