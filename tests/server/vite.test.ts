import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import agentFeedback, { createSourcePathService, isAgentFeedbackRequestAllowed } from "../../src/vite/index.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-feedback-vite-"));
  roots.push(root);
  const a = path.join(root, "src/duplicate-a/Card.tsx");
  const b = path.join(root, "src/duplicate-b/Card.tsx");
  mkdirSync(path.dirname(a), { recursive: true });
  mkdirSync(path.dirname(b), { recursive: true });
  writeFileSync(a, "export const Card = () => null;\n");
  writeFileSync(b, "export const Card = () => null;\n");
  return { root, a, b };
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("serve-only Vite plugin", () => {
  it("is serve-only, injects through the namespaced virtual module, and canonicalizes under root", () => {
    const plugin = agentFeedback({ root: "/tmp/demo", clientExtensions: ["/tmp/demo/extension.ts"] });
    const resolveId = plugin.resolveId as Function;
    const load = plugin.load as Function;
    expect(plugin.apply).toBe("serve");
    expect(plugin.transform).toMatchObject({ order: "post" });
    expect(resolveId.call({} as never, "virtual:agent-feedback/client", undefined, {} as never)).toBe("\0virtual:agent-feedback/client");
    const loaded = load.call({} as never, "\0virtual:agent-feedback/client", {} as never);
    expect(String(loaded)).toContain("/tmp/demo/extension.ts");
    expect(String(loaded)).toContain('from "@gchust/agent-feedback"');
    expect(String(loaded)).toContain('from "@gchust/agent-feedback/vite/client"');
    expect(String(loaded)).toContain("mountAgentFeedback");
    expect(String(loaded)).toContain("mountAgentFeedback({ transport, extensions })");
    expect(String(loaded)).toContain("window[key]?.()");
    expect(String(loaded)).toContain("import.meta.hot.accept()");
    expect(String(loaded)).toContain("import.meta.hot.dispose");
    expect(String(loaded)).not.toContain("extension.setup");
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
    expect(source.canonicalize("src/App.tsx")).toBeNull();
    expect(source.canonicalize("../outside.ts")).toBeNull();
    expect(() => agentFeedback({ root: "/tmp/demo", dir: "../outside" })).toThrow("inside root");
    expect(() => agentFeedback({ endpoint: "https://evil.test" })).toThrow("root-relative");
  });

  it("normalizes only the post-React single basename sourcemap source to the exact module", () => {
    const { root, a, b } = fixture();
    const plugin = agentFeedback({ root });
    const transform = (plugin.transform as { handler: Function }).handler;
    const map = {
      version: 3,
      names: ["Card"],
      sources: ["Card.tsx"],
      sourcesContent: ["export const Card = () => null;"],
      mappings: "AAAA",
    };
    const result = transform.call(
      { getCombinedSourcemap: () => map },
      "export const Card = () => null;",
      a,
      { ssr: false }
    );
    expect(result).toBeUndefined();
    expect(map).toMatchObject({
      mappings: "AAAA",
      names: ["Card"],
      sources: [pathToFileURL(a).href],
      file: a,
      sourceRoot: undefined,
    });

    expect(transform.call(
      { getCombinedSourcemap: () => ({ ...map, sources: ["../../../outside.tsx"] }) },
      "code",
      `${a}?direct#fragment`
    )).toBeUndefined();
    expect(transform.call(
      { getCombinedSourcemap: () => map },
      "code",
      path.join(root, "node_modules/pkg/Card.tsx")
    )).toBeUndefined();
    const absoluteMap = { ...map, sources: [b] };
    const second = transform.call(
      { getCombinedSourcemap: () => absoluteMap },
      "code",
      b
    );
    expect(second).toBeUndefined();
    expect(absoluteMap.sources).toEqual([pathToFileURL(b).href]);
    expect(transform.call({ getCombinedSourcemap: () => map }, "code", a, { ssr: true })).toBeUndefined();
  });

  it("injects the virtual client under the resolved Vite base", () => {
    const { root } = fixture();
    const plugin = agentFeedback({ root });
    (plugin.configResolved as Function).call({} as never, { root, base: "/x/main/" });
    const tags = (plugin.transformIndexHtml as Function).call({} as never, "", {} as never);
    expect(tags[0].attrs.src).toBe("/x/main/@id/__x00__virtual:agent-feedback/client");
  });

  it("serves distinct file URL sources after React transforms", async () => {
    const { root, a, b } = fixture();
    const server = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [react(), agentFeedback({ root })],
    });
    await server.listen();
    try {
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("missing Vite address");
      for (const file of [a, b]) {
        const url = `http://127.0.0.1:${address.port}/${path.relative(root, file).split(path.sep).join("/")}`;
        const code = await (await fetch(url)).text();
        const encoded = code.match(/sourceMappingURL=data:application\/json;base64,([A-Za-z\d+/=]+)/)?.[1];
        expect(encoded).toBeTruthy();
        const map = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
        expect(map.sources).toEqual([pathToFileURL(file).href]);
      }
    } finally {
      await server.close();
    }
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
