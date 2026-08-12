import { describe, expect, it, vi } from "vitest";

import agentFeedback, { createSourcePathService, isAgentFeedbackRequestAllowed } from "../../src/vite/index.js";

describe("serve-only Vite plugin", () => {
  it("is serve-only, injects through the namespaced virtual module, and canonicalizes under root", () => {
    const plugin = agentFeedback({ root: "/tmp/demo", clientExtensions: ["/tmp/demo/extension.ts"] });
    const resolveId = plugin.resolveId as Function;
    const load = plugin.load as Function;
    expect(plugin.apply).toBe("serve");
    expect(resolveId.call({} as never, "virtual:agent-feedback/client", undefined, {} as never)).toBe("\0virtual:agent-feedback/client");
    const loaded = load.call({} as never, "\0virtual:agent-feedback/client", {} as never);
    expect(String(loaded)).toContain("/tmp/demo/extension.ts");
    expect(String(loaded)).toContain('from "@gchust/agent-feedback"');
    expect(String(loaded)).toContain('from "@gchust/agent-feedback/vite/client"');
    expect(String(loaded)).toContain("mountAgentFeedback");
    const tags = (plugin.transformIndexHtml as Function).call({} as never, "", {} as never);
    expect(tags).toEqual([{
      tag: "script",
      attrs: {
        type: "module",
        src: "/@id/__x00__virtual:agent-feedback/client",
      },
      injectTo: "head",
    }]);
    expect(tags[0]).not.toHaveProperty("children");
    const source = createSourcePathService("/tmp/demo");
    expect(source.canonicalize("src/App.tsx")).toBe("src/App.tsx");
    expect(source.canonicalize("../outside.ts")).toBeNull();
    expect(() => agentFeedback({ root: "/tmp/demo", dir: "../outside" })).toThrow("inside root");
    expect(() => agentFeedback({ endpoint: "https://evil.test" })).toThrow("root-relative");
  });

  it("warns only for explicit remote opt-in", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    agentFeedback();
    expect(warn).not.toHaveBeenCalled();
    agentFeedback({ allowRemote: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("remote access enabled"));
    warn.mockRestore();
  });

  it("defaults to loopback and always requires the token plus matching host origins", () => {
    const request = { headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" } } as never;
    expect(isAgentFeedbackRequestAllowed("127.0.0.1", false, "token", "token", request)).toBe(true);
    expect(isAgentFeedbackRequestAllowed("10.0.0.2", false, "token", "token", request)).toBe(false);
    expect(isAgentFeedbackRequestAllowed("10.0.0.2", true, "token", "token", request)).toBe(true);
    expect(isAgentFeedbackRequestAllowed("127.0.0.1", false, "wrong", "token", request)).toBe(false);
    expect(isAgentFeedbackRequestAllowed("127.0.0.1", false, "token", "token", { headers: { host: "127.0.0.1:5173", origin: "http://evil.test" } } as never)).toBe(false);
  });

});
