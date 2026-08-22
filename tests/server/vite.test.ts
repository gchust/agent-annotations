import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import pkg from "../../package.json" with { type: "json" };
import agentAnnotations, { createSourcePathService, isAgentAnnotationsRequestAllowed } from "../../src/vite/index.js";

const roots: string[] = [];
const fixture = () => {
  const parent = mkdtempSync(path.join(tmpdir(), "agent-annotations-vite-"));
  roots.push(parent);
  const root = path.join(parent, "workspace");
  const a = path.join(root, "src/duplicate-a/Card.tsx");
  const b = path.join(root, "src/duplicate-b/Card.tsx");
  mkdirSync(path.dirname(a), { recursive: true });
  mkdirSync(path.dirname(b), { recursive: true });
  writeFileSync(a, "export const Card = () => null;\n");
  writeFileSync(b, "export const Card = () => null;\n");
  return { parent, root, a, b };
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("serve-only Vite plugin", () => {
  it("is serve-only, injects through the namespaced virtual module, and canonicalizes under root", () => {
    const plugin = agentAnnotations({ root: "/tmp/demo", clientExtensions: ["/tmp/demo/extension.ts"] });
    const resolveId = plugin.resolveId as Function;
    const load = plugin.load as Function;
    expect(plugin.apply).toBe("serve");
    expect(plugin.transform).toMatchObject({ order: "pre" });
    expect(resolveId.call({} as never, "virtual:agent-annotations/client", undefined, {} as never)).toBe("\0virtual:agent-annotations/client");
    const loaded = load.call({} as never, "\0virtual:agent-annotations/client", {} as never);
    expect(String(loaded)).toContain("/tmp/demo/extension.ts");
    expect(String(loaded)).toContain(`from ${JSON.stringify(pkg.name)}`);
    expect(String(loaded)).toContain(`from ${JSON.stringify(`${pkg.name}/vite/client`)}`);
    expect(String(loaded)).toContain("mountAgentAnnotations");
    expect(String(loaded)).toContain("runtimeId: window[runtimeKey]");
    expect(String(loaded)).toContain("mounted.reportBrowserUpdate()");
    expect(String(loaded)).toContain("vite:afterUpdate");
    expect(String(loaded)).toContain("responses.every((response) => response.ok)");
    expect(String(loaded)).toContain("window[key]?.(true)");
    expect(String(loaded)).toContain("import.meta.hot.accept()");
    expect(String(loaded)).toContain("import.meta.hot.dispose");
    expect(String(loaded)).not.toContain("extension.setup");
    const tags = (plugin.transformIndexHtml as Function).call({} as never, "", {} as never);
    expect(tags).toEqual([{
      tag: "script",
      attrs: {
        type: "module",
        src: "/@id/__x00__virtual:agent-annotations/client",
      },
      injectTo: "head",
    }]);
    expect(tags[0]).not.toHaveProperty("children");
    const source = createSourcePathService("/tmp/demo");
    expect(source.canonicalize("src/App.tsx")).toBeNull();
    expect(source.canonicalize("../outside.ts")).toBeNull();
    expect(() => agentAnnotations({ root: "/tmp/demo", dir: "../outside" })).toThrow("inside root");
    expect(() => agentAnnotations({ endpoint: "https://evil.test" })).toThrow("root-relative");
  });

  it("returns a canonical identity { code, map } for modules under root", () => {
    const { parent, root, a, b } = fixture();
    const plugin = agentAnnotations({ root });
    const transform = (plugin.transform as { handler: Function }).handler;
    const code = "export const Card = () => null;\n";
    const result = transform.call({} as never, code, a, { ssr: false });
    expect(result).toEqual({
      code,
      map: {
        version: 3,
        file: a,
        sources: [pathToFileURL(a).href],
        sourcesContent: [code],
        names: [],
        mappings: expect.any(String),
      },
    });
    expect((result as { map: { mappings: string } }).map.mappings.length).toBeGreaterThan(0);
    expect(transform.call({} as never, "code", b, { ssr: false })).toMatchObject({
      map: { sources: [pathToFileURL(b).href], file: b },
    });
    expect(transform.call({} as never, "code", `${a}?direct#fragment`, { ssr: false })).toMatchObject({
      map: { sources: [pathToFileURL(a).href], file: a },
    });
    expect(transform.call({} as never, "code", path.join(root, "node_modules/pkg/Card.tsx"), { ssr: false })).toBeUndefined();
    expect(transform.call({} as never, "code", a, { ssr: true })).toBeUndefined();
    const outside = path.join(parent, "outside.ts");
    writeFileSync(outside, "outside");
    expect(transform.call({} as never, "code", outside, { ssr: false })).toBeUndefined();
  });

  it("injects the virtual client under the resolved Vite base", () => {
    const { root } = fixture();
    const plugin = agentAnnotations({ root });
    (plugin.configResolved as Function).call({} as never, { root, base: "/x/main/" });
    const tags = (plugin.transformIndexHtml as Function).call({} as never, "", {} as never);
    expect(tags[0].attrs.src).toBe("/x/main/@id/__x00__virtual:agent-annotations/client");
    const loaded = (plugin.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never);
    expect(String(loaded)).toContain('"endpoint":"/x/main/__agent-annotations"');
    expect(String(loaded)).toContain('"screenshotEvidence":"auto"');
    expect(String(loaded)).toContain("screenshotEvidence: config.screenshotEvidence");
  });

  it("combines a custom endpoint with the resolved Vite base", async () => {
    const { root } = fixture();
    const plugin = agentAnnotations({ root, endpoint: "/custom-aa" });
    (plugin.configResolved as Function).call({} as never, { root, base: "/app/" });
    const loaded = (plugin.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never);
    // The injected endpoint is the base-resolved custom endpoint.
    expect(String(loaded)).toContain('"endpoint":"/app/custom-aa"');
    const server = await createServer({
      root,
      base: "/app/",
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [agentAnnotations({ root, endpoint: "/custom-aa" })],
    });
    await server.listen();
    try {
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const base = `http://127.0.0.1:${address.port}`;
      const token = JSON.parse(
        readFileSync(path.join(root, ".agent-annotations", "session.json"), "utf8")
      ).token;
      // The middleware serves the task under the base + custom endpoint...
      const task = await fetch(`${base}/app/custom-aa/task`, {
        headers: { "x-agent-annotations-token": token },
      });
      expect(task.status).toBe(200);
      // ...and rejects requests under the default endpoint path.
      const denied = await fetch(`${base}/app/__agent-annotations/task`, {
        headers: { "x-agent-annotations-token": token },
      });
      expect(denied.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("injects and validates the screenshot evidence mode", async () => {
    for (const mode of ["auto", "manual", "off"] as const) {
      const plugin = agentAnnotations({ root: "/tmp/demo", screenshotEvidence: mode });
      const loaded = String((plugin.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
      expect(loaded).toContain(`"screenshotEvidence":${JSON.stringify(mode)}`);
      expect(loaded).toContain("screenshotEvidence: config.screenshotEvidence");
    }
    expect(() => agentAnnotations({ root: "/tmp/demo", screenshotEvidence: "always" as never }))
      .toThrow(TypeError);
    // The handoff option is validated at the plugin boundary and injected.
    const withHandoff = agentAnnotations({
      root: "/tmp/demo",
      handoff: { command: "custom", verificationCommands: ["pnpm typecheck"] },
    });
    const loaded = String((withHandoff.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
    expect(loaded).toContain('"handoff":');
    expect(loaded).toContain("handoff: config.handoff");
    expect(() => agentAnnotations({ root: "/tmp/demo", handoff: { command: "bad\ncommand" } }))
      .toThrow(TypeError);
    // builtins/initialState are JSON-safe validated and injected.
    const configured = agentAnnotations({
      root: "/tmp/demo",
      builtins: { help: false, shortcuts: { pick: { key: "X", code: "KeyX", primary: true, alt: true, shift: false } } },
      initialState: { collapsed: false },
    });
    const configuredLoaded = String((configured.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
    expect(configuredLoaded).toContain('"builtins":{"help":false');
    expect(configuredLoaded).toContain('"initialState":{"collapsed":false}');
    expect(configuredLoaded).toContain("builtins: config.builtins");
    expect(configuredLoaded).toContain("initialState: config.initialState");
    expect(() => agentAnnotations({ root: "/tmp/demo", builtins: { pick: "yes" as never } }))
      .toThrow(/builtins pick must be a boolean/);
    expect(() => agentAnnotations({ root: "/tmp/demo", initialState: { collapsed: 1 as never } }))
      .toThrow(/initialState collapsed must be a boolean/);
    const noBuiltins = agentAnnotations({ root: "/tmp/demo", builtins: false });
    const noBuiltinsLoaded = String((noBuiltins.load as unknown as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
    expect(noBuiltinsLoaded).toContain('"builtins":false');
  });

  it("serves distinct file URL sources after React transforms", async () => {
    const { root, a, b } = fixture();
    const server = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [react(), agentAnnotations({ root })],
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

  it("appends bounded redacted diagnostics through the authenticated endpoint", async () => {
    const { root } = fixture();
    const server = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [agentAnnotations({ root })],
    });
    await server.listen();
    try {
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const base = `http://127.0.0.1:${address.port}`;
      const session = JSON.parse(
        readFileSync(path.join(root, ".agent-annotations", "session.json"), "utf8")
      );
      expect(session.workspaceRoot).toBe(realpathSync(path.resolve(root)));
      expect(session.runtimeRoot).toBe(realpathSync(path.join(path.resolve(root), ".agent-annotations")));
      const token = session.token;
      const post = (body: unknown) => fetch(`${base}/__agent-annotations/diagnostics`, {
        method: "POST",
        headers: { "x-agent-annotations-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = await post({
        entries: [{
          source: "console",
          message: "Bearer UNIQUE_SECRET_SENTINEL_vite",
          timestamp: "2026-08-12T12:00:00.000Z",
        }],
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as { entries: Array<{ message: string }> };
      expect(payload.entries[0]!.message).not.toContain("UNIQUE_SECRET_SENTINEL_vite");
      expect(payload.entries[0]!.message).toContain("[REDACTED]");
      const denied = await fetch(`${base}/__agent-annotations/diagnostics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [] }),
      });
      expect(denied.status).toBe(404);
      const invalid = await post({
        entries: [{ source: "network", message: "x", timestamp: "2026-08-12T12:00:00.000Z" }],
      });
      expect(invalid.status).toBe(400);
      const oversized = await post({
        entries: [{
          source: "console",
          message: "x".repeat(20_000),
          timestamp: "2026-08-12T12:00:00.000Z",
        }],
      });
      expect(oversized.status).toBe(400);
      const persisted = JSON.parse(
        readFileSync(path.join(root, ".agent-annotations", "diagnostics.json"), "utf8")
      );
      expect(JSON.stringify(persisted)).not.toContain("x".repeat(20));
      expect(persisted).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("normalizes Windows drive and backslash extension specifiers to valid Vite ids", () => {
    const plugin = agentAnnotations({
      root: "/demo",
      clientExtensions: ["C:\\demo\\extension.ts", "/unix/demo/extension.ts", "./relative/extension.ts"],
    });
    const loaded = String((plugin.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
    expect(loaded).toContain(JSON.stringify("/C:/demo/extension.ts"));
    expect(loaded).toContain(JSON.stringify("/unix/demo/extension.ts"));
    expect(loaded).toContain(JSON.stringify("./relative/extension.ts"));
    const forward = agentAnnotations({ root: "/demo", clientExtensions: ["C:/demo/extension.ts"] });
    const forwardLoaded = String((forward.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
    expect(forwardLoaded).toContain(JSON.stringify("/C:/demo/extension.ts"));
  });

  it("loads the platform's absolute extension specifier through a real Vite server", async () => {
    const { root } = fixture();
    const extension = path.join(root, "src/extension.ts");
    writeFileSync(extension, "export default { id: 'platform-ext', apiVersion: 1 };\n");
    const plugin = agentAnnotations({ root, clientExtensions: [extension] });
    const expectedId = extension.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:");
    const loaded = String((plugin.load as Function).call({} as never, "\0virtual:agent-annotations/client", {} as never));
    expect(loaded).toContain(JSON.stringify(expectedId));
    const server = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [agentAnnotations({ root, clientExtensions: [extension] })],
    });
    await server.listen();
    try {
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("missing Vite address");
      const base = `http://127.0.0.1:${address.port}`;
      const virtual = await (await fetch(`${base}/@id/__x00__virtual:agent-annotations/client`)).text();
      expect(virtual).toContain("extension.ts");
      const relativeUrl = path.relative(root, extension).split(path.sep).join("/");
      const extensionCode = await (await fetch(`${base}/${relativeUrl}`)).text();
      expect(extensionCode).toContain("platform-ext");
    } finally {
      await server.close();
    }
  });

  it("persists authenticated browser state heartbeats and cleans only its own state on close", async () => {
    const { root } = fixture();
    const statePath = path.join(root, ".agent-annotations", "browser-states", "runtime-1.json");
    const state = {
      schema: "agent-annotations.browser-state.v2",
      runtimeId: "runtime-1",
      clientVersion: "0.1.0-alpha.0",
      routeKey: "/",
      taskId: "task-1",
      taskRevision: 0,
      browserUpdateRevision: 1,
      referencedSourceRevision: null,
      referencedSourceFiles: [],
      annotationHealth: [],
      mountedAt: "2026-08-12T12:00:00.000Z",
      lastHeartbeatAt: "2026-08-12T12:00:05.000Z",
    };
    const session = async (server: import("vite").ViteDevServer) => {
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const base = `http://127.0.0.1:${address.port}`;
      const token = JSON.parse(
        readFileSync(path.join(root, ".agent-annotations", "session.json"), "utf8")
      ).token;
      const heartbeat = (body: unknown) => fetch(`${base}/__agent-annotations/heartbeat`, {
        method: "POST",
        headers: { "x-agent-annotations-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { base, token, heartbeat };
    };

    const first = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [agentAnnotations({ root })],
    });
    await first.listen();
    const firstSession = await session(first);
    try {
      expect((await firstSession.heartbeat(state)).status).toBe(200);
      const persisted = JSON.parse(readFileSync(statePath, "utf8"));
      expect(persisted).toMatchObject({ schema: state.schema, runtimeId: "runtime-1", routeKey: "/" });
      expect(persisted.lastHeartbeatAt).not.toBe(state.lastHeartbeatAt);
      expect(JSON.stringify(persisted)).not.toContain(firstSession.token);
      // The legacy bare transport heartbeat (no body) stays accepted.
      const bare = await fetch(`${firstSession.base}/__agent-annotations/heartbeat`, {
        method: "POST",
        headers: { "x-agent-annotations-token": firstSession.token },
      });
      expect(bare.status).toBe(200);
      expect(JSON.parse(readFileSync(statePath, "utf8")).runtimeId).toBe("runtime-1");
      // A bare transport liveness heartbeat never overwrites the state.
      await firstSession.heartbeat({});
      expect(JSON.parse(readFileSync(statePath, "utf8")).runtimeId).toBe("runtime-1");
      // Malformed claimed browser-state payloads are strictly rejected.
      const wrongSchema = await firstSession.heartbeat({ ...state, schema: "other.v1" });
      expect(wrongSchema.status).toBe(400);
      const unknownField = await firstSession.heartbeat({ ...state, token: "secret" });
      expect(unknownField.status).toBe(400);
      const queryRoute = await firstSession.heartbeat({ ...state, routeKey: "/?token=abc" });
      expect(queryRoute.status).toBe(400);
      expect(JSON.parse(readFileSync(statePath, "utf8")).runtimeId).toBe("runtime-1");
      // Invalid JSON and non-empty unknown shapes are not liveness heartbeats.
      const invalidJson = await fetch(`${firstSession.base}/__agent-annotations/heartbeat`, {
        method: "POST",
        headers: { "x-agent-annotations-token": firstSession.token, "content-type": "application/json" },
        body: "{oops",
      });
      expect(invalidJson.status).toBe(400);
      const unknownShape = await firstSession.heartbeat({ foo: 1 });
      expect(unknownShape.status).toBe(400);
      // Hash routes are preserved; only raw query portions are rejected.
      const hashRoute = await firstSession.heartbeat({ ...state, routeKey: "/#/settings" });
      expect(hashRoute.status).toBe(200);
      expect(JSON.parse(readFileSync(statePath, "utf8")).routeKey).toBe("/#/settings");
      // An unauthenticated heartbeat is denied.
      const denied = await fetch(`${firstSession.base}/__agent-annotations/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      expect(denied.status).toBe(404);
    } finally {
      await first.close();
    }
    // Closing the server removed only its own runtime's state.
    expect(existsSync(statePath)).toBe(false);

    // A replacement runtime's state is preserved on close.
    const second = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [agentAnnotations({ root })],
    });
    await second.listen();
    const secondSession = await session(second);
    const replacementPath = path.join(root, ".agent-annotations", "browser-states", "runtime-3.json");
    try {
      await secondSession.heartbeat({ ...state, runtimeId: "runtime-2" });
      writeFileSync(replacementPath, JSON.stringify({ ...state, runtimeId: "runtime-3" }));
    } finally {
      await second.close();
    }
    expect(JSON.parse(readFileSync(replacementPath, "utf8")).runtimeId).toBe("runtime-3");
    rmSync(replacementPath, { force: true });
  });

  it("warns only for explicit remote opt-in", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    agentAnnotations();
    expect(warn).not.toHaveBeenCalled();
    agentAnnotations({ allowRemote: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("remote access enabled"));
    warn.mockRestore();
  });

  it("defaults to loopback and always requires the token plus matching host origins", () => {
    const request = { headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" } } as never;
    expect(isAgentAnnotationsRequestAllowed("127.0.0.1", false, "token", "token", request)).toBe(true);
    expect(isAgentAnnotationsRequestAllowed("10.0.0.2", false, "token", "token", request)).toBe(false);
    expect(isAgentAnnotationsRequestAllowed("10.0.0.2", true, "token", "token", request)).toBe(true);
    expect(isAgentAnnotationsRequestAllowed("127.0.0.1", false, "wrong", "token", request)).toBe(false);
    expect(isAgentAnnotationsRequestAllowed("127.0.0.1", false, "token", "token", { headers: { host: "127.0.0.1:5173", origin: "http://evil.test" } } as never)).toBe(false);
  });

});
