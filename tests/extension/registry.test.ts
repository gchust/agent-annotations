import { describe, expect, it, vi } from "vitest";

import {
  ClientExtensionRegistry,
  defineClientExtension,
  registerClientExtension,
  type AgentFeedbackClientExtension,
  type FeedbackExporter,
  type FeedbackRedactor,
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
const exporter = (id: string): FeedbackExporter => ({ id, export: () => "{}" });
const redactor = (id: string): FeedbackRedactor => ({ id, redact: (task) => task });
const extension = (
  id: string,
  values: Omit<AgentFeedbackClientExtension, "id" | "apiVersion"> = {}
) => defineClientExtension({ id, apiVersion: 1, ...values });

describe("ClientExtensionRegistry", () => {
  it("stores and sorts every family without executing setup", () => {
    const registry = new ClientExtensionRegistry();
    const setup = vi.fn();
    const host: HostIntegration = { locale: () => "en-US" };
    registerClientExtension(registry, extension("z-extension", {
      setup,
      toolbar: [
        { ...action("late", "L"), order: 20 },
        { ...action("host", "H"), group: "host", order: -10 },
        { ...action("first", "F"), order: 10 },
      ],
      panels: [panel("z-panel"), panel("a-panel")],
      targetEnrichers: [enricher("z-enricher"), enricher("a-enricher")],
      exporters: [exporter("z-exporter"), exporter("a-exporter")],
      redactors: [redactor("z-redactor"), redactor("a-redactor")],
      messages: { z: "last", shared: "z" },
      host,
    }));
    registry.register(extension("a-extension", { messages: { a: "first", shared: "a" } }));

    expect(setup).not.toHaveBeenCalled();
    expect(registry.getExtensions().map(({ id }) => id)).toEqual(["a-extension", "z-extension"]);
    expect(registry.getToolbarContributions().map(({ id }) => id)).toEqual(["first", "late", "host"]);
    expect(registry.getPanels().map(({ id }) => id)).toEqual(["a-panel", "z-panel"]);
    expect(registry.getTargetEnrichers().map(({ id }) => id)).toEqual(["a-enricher", "z-enricher"]);
    expect(registry.getExporters().map(({ id }) => id)).toEqual(["a-exporter", "z-exporter"]);
    expect(registry.getRedactors().map(({ id }) => id)).toEqual(["a-redactor", "z-redactor"]);
    expect(registry.getMessages()).toEqual({ a: "first", shared: "z", z: "last" });
    expect(registry.getHostIntegration()).toBe(host);
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

  it("rejects every duplicate contribution ID across registrations", () => {
    const families = [
      ["toolbar contribution", { toolbar: [action("same", "A")] }],
      ["panel", { panels: [panel("same")] }],
      ["target enricher", { targetEnrichers: [enricher("same")] }],
      ["exporter", { exporters: [exporter("same")] }],
      ["redactor", { redactors: [redactor("same")] }],
    ] as const;
    for (const [kind, values] of families) {
      const registry = new ClientExtensionRegistry();
      registry.register(extension("one", values));
      expect(() => registry.register(extension("two", values))).toThrow(`Duplicate ${kind} ID: same`);
      expect(registry.getExtensions().map(({ id }) => id)).toEqual(["one"]);
    }

    const registry = new ClientExtensionRegistry();
    registry.register(extension("same"));
    expect(() => registry.register(extension("same"))).toThrow("Duplicate extension ID: same");
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
      expect(() => registry.register(extension("broken", values))).toThrow(`Duplicate ${kind} ID: same`);
      expect(registry.getExtensions()).toEqual([]);
    }
  });

  it("rejects key and code shortcut conflicts, including within one extension", () => {
    const registry = new ClientExtensionRegistry();
    registry.register(extension("one", { toolbar: [action("copy", "C")] }));
    expect(() => registry.register(extension("two", {
      toolbar: [{ ...action("clone", "X"), shortcut: { key: "c", code: "KeyX", primary: true, alt: true, shift: false } }],
    }))).toThrow("Duplicate toolbar shortcut: clone conflicts with copy");
    expect(() => registry.register(extension("three", {
      toolbar: [{ ...action("symbol", "X"), shortcut: { key: "χ", code: "keyc", primary: true, alt: true, shift: false } }],
    }))).toThrow("Duplicate toolbar shortcut: symbol conflicts with copy");
    const intra = new ClientExtensionRegistry();
    expect(() => intra.register(extension("broken", { toolbar: [
      action("first", "A"),
      { ...action("second", "B"), shortcut: { key: "a", code: "KeyB", primary: true, alt: true, shift: false } },
    ] }))).toThrow("Duplicate toolbar shortcut: second conflicts with first");
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
    }] }))).toThrow("Unknown toolbar panel ID: missing");
    expect(missing.getExtensions()).toEqual([]);

    const linked = new ClientExtensionRegistry();
    expect(() => linked.register(extension("linked", { toolbar: [{
      ...action("open", "P"), kind: "panel", execute: undefined, panelId: "panel",
    }], panels: [panel("panel")] }))).not.toThrow();
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
      { setup: "bad" as never },
    ];
    for (const [index, values] of invalid.entries()) {
      const registry = new ClientExtensionRegistry();
      expect(() => registry.register(extension(`broken-${index}`, values))).toThrow();
      expect(registry.getExtensions()).toEqual([]);
      expect(registry.getToolbarContributions()).toEqual([]);
    }
  });

  it("preserves defineClientExtension identity", () => {
    const value = { id: "identity", apiVersion: 1 } as const;
    expect(defineClientExtension(value)).toBe(value);
  });
});
