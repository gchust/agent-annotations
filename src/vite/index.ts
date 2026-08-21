import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import MagicString from "magic-string";
import type { Plugin } from "vite";
import type { AgentAnnotationsHandoffConfig } from "../types/index.js";

import { FileTaskStore } from "../server/store.js";
import {
  parseAgentAnnotationsBrowserState,
  readAgentAnnotationsBrowserState,
  removeAgentAnnotationsBrowserState,
  writeAgentAnnotationsBrowserState,
} from "../server/browser-state.js";
import { appendDiagnostics } from "../server/diagnostics.js";
import { createSourcePathService } from "../server/source-path.js";
import { validateAgentAnnotationsHandoffConfig } from "../core/handoff.js";
import { PACKAGE_NAME } from "../metadata.js";

const VIRTUAL_ID = "virtual:agent-annotations/client";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const TOKEN_HEADER = "x-agent-annotations-token";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BODY_BYTES = 3 * 1024 * 1024;
const MAX_DIAGNOSTICS_BODY_BYTES = 16 * 1024;
const SOURCE_MODULE = /\.[cm]?[jt]sx?$/i;
const WINDOWS_DRIVE = /^([A-Za-z]:)[\\/]/;

const normalizeClientExtensionSpecifier = (specifier: string): string => {
  // Windows drive paths (C:\x, C:/x) become Vite's canonical /C:/x id.
  const drive = WINDOWS_DRIVE.exec(specifier);
  if (drive) return `/${drive[1]}${specifier.slice(2).replace(/\\/g, "/")}`;
  // Unix absolute paths, relative specifiers, and package ids stay as authored.
  return specifier;
};

export type AgentAnnotationsPluginOptions = {
  root?: string;
  dir?: string;
  endpoint?: string;
  allowRemote?: boolean;
  clientExtensions?: string[];
  screenshotEvidence?: "auto" | "manual" | "off";
  handoff?: AgentAnnotationsHandoffConfig;
};

export const agentAnnotationsViteEntry = true;
export const isAgentAnnotationsRequestAllowed = (
  remoteAddress: string | undefined,
  allowRemote: boolean,
  providedToken: string | undefined,
  expectedToken: string,
  request: Pick<IncomingMessage, "headers">
): boolean =>
  (allowRemote || isLoopback(remoteAddress)) &&
  providedToken === expectedToken &&
  requestOriginMatches(request);

const isLoopback = (address: string | undefined): boolean =>
  address === undefined ||
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const requestOriginMatches = (request: Pick<IncomingMessage, "headers">): boolean => {
  const expected = request.headers.host;
  if (!expected) return false;
  for (const value of [request.headers.origin, request.headers.referer]) {
    if (!value) continue;
    try {
      if (new URL(value).host !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const json = (
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>
): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const body = async (request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const rawBody = async (request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export default function agentAnnotations(
  options: AgentAnnotationsPluginOptions = {}
): Plugin {
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(options.endpoint ?? "/__agent-annotations")) {
    throw new Error("agentAnnotations endpoint must be a root-relative path");
  }
  const screenshotEvidence = options.screenshotEvidence ?? "auto";
  if (screenshotEvidence !== "auto" && screenshotEvidence !== "manual" && screenshotEvidence !== "off") {
    throw new TypeError(
      `screenshotEvidence must be "auto", "manual", or "off" (received ${options.screenshotEvidence})`
    );
  }
  // Strict handoff config boundary at the plugin level: only shapes Copy text.
  const handoff = validateAgentAnnotationsHandoffConfig(options.handoff);
  let root = path.resolve(options.root ?? process.cwd());
  let realRoot = existsSync(root) ? realpathSync(root) : root;
  let runtimeRoot = path.resolve(root, options.dir ?? ".agent-annotations");
  const assertRuntimeRoot = (): void => {
    if (!inside(root, runtimeRoot)) {
      throw new Error("agentAnnotations dir must stay inside root");
    }
  };
  assertRuntimeRoot();
  const endpoint = options.endpoint ?? "/__agent-annotations";
  const allowRemote = options.allowRemote === true;
  const extensions = (options.clientExtensions ?? []).map(normalizeClientExtensionSpecifier);
  const token = randomBytes(32).toString("hex");
  let sourcePaths = createSourcePathService(root);
  let store = new FileTaskStore(runtimeRoot);
  let closeInstalled = false;
  let viteBase = "/";
  let resolvedEndpoint = endpoint;
  // Runtime identity of the last browser state this server session accepted;
  // shutdown removes only state owned by this session's runtime.
  let browserRuntimeId: string | null = null;

  if (allowRemote) {
    console.warn(
      "[agent-annotations] remote access enabled: dev endpoints accept non-loopback clients; the session token is still required"
    );
  }

  const persistSession = (address: ReturnType<NonNullable<import("node:http").Server["address"]>>): void => {
    if (!address || typeof address === "string") return;
    const origin = `http://127.0.0.1:${address.port}`;
    mkdirSync(runtimeRoot, { recursive: true });
    store.writeSession({
      endpoint: resolvedEndpoint,
      origin,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
      workspaceRoot: realRoot,
      runtimeRoot: realpathSync(runtimeRoot),
    });
  };

  const serverPlugin: Plugin = {
    name: "agent-annotations",
    apply: "serve",
    configResolved(config) {
      viteBase = config.base;
      resolvedEndpoint = `${viteBase.replace(/\/$/, "")}${endpoint}`;
      root = path.resolve(options.root ?? config.root);
      realRoot = realpathSync(root);
      runtimeRoot = path.resolve(root, options.dir ?? ".agent-annotations");
      assertRuntimeRoot();
      store = new FileTaskStore(runtimeRoot);
      sourcePaths = createSourcePathService(root);
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      const imports = extensions
        .map((specifier, index) => `import * as extension${index} from ${JSON.stringify(specifier)};`)
        .join("\n");
      const values = extensions.map((_, index) => `extension${index}.default ?? extension${index}`).join(", ");
      return [
        `import { mountAgentAnnotations } from ${JSON.stringify(PACKAGE_NAME)};`,
        `import { HttpTaskTransport } from ${JSON.stringify(`${PACKAGE_NAME}/vite/client`)};`,
        imports,
        `const config = ${JSON.stringify({ endpoint: resolvedEndpoint, token, screenshotEvidence, handoff })};`,
        `const extensions = [${values}];`,
        "const key = Symbol.for('agent-annotations.mount');",
        "window[key]?.();",
        "const transport = new HttpTaskTransport(config);",
        `const mounted = await mountAgentAnnotations({ transport, extensions, screenshotEvidence: config.screenshotEvidence, browserStatus: { endpoint: config.endpoint, token: config.token }, handoff: config.handoff });`,
        "window[key] = () => { mounted.unmount(); delete window[key]; };",
        "mounted.refreshAppliedSourceRevision();",
        "if (import.meta.hot) {",
        "  import.meta.hot.accept();",
        "  import.meta.hot.dispose(() => window[key]?.());",
        "  import.meta.hot.on('vite:afterUpdate', () => { mounted.refreshAppliedSourceRevision(); });",
        "}",
      ].filter(Boolean).join("\n");
    },
    transform: {
      order: "pre",
      handler(code, id, transformOptions) {
        const file = id.split(/[?#]/, 1)[0]!;
        if (
          transformOptions?.ssr ||
          file.includes("\0") ||
          file.includes("/node_modules/") ||
          !SOURCE_MODULE.test(file) ||
          !path.isAbsolute(file) ||
          !existsSync(file)
        ) return;
        const realModule = realpathSync(file);
        if (!statSync(realModule).isFile() || !inside(realRoot, realModule)) return;
        const map = {
          ...new MagicString(code).generateMap({
            source: pathToFileURL(realModule).href,
            includeContent: true,
            hires: true,
          }),
          file,
        };
        return { code, map };
      },
    },
    transformIndexHtml() {
      return [{
        tag: "script",
        attrs: {
          type: "module",
          src: `${viteBase}@id/__x00__virtual:agent-annotations/client`,
        },
        injectTo: "head",
      }];
    },
    configureServer(server) {
      const httpServer = server.httpServer;
      const listening = () => persistSession(httpServer?.address() ?? null);
      if (httpServer?.listening) listening();
      else httpServer?.once("listening", listening);
      if (httpServer && !closeInstalled) {
        closeInstalled = true;
        const signals = ["SIGINT", "SIGTERM"] as const;
        const onExit = () => {
          cleanupBrowserState();
          store.closeSync(token);
        };
        const onSignal = (signal: NodeJS.Signals) => {
          cleanupBrowserState();
          store.closeSync(token);
          process.kill(process.pid, signal);
        };
        const cleanupBrowserState = (): void => {
          // Remove only the browser state written by this session's runtime;
          // a replacement runtime's state is preserved.
          const state = readAgentAnnotationsBrowserState(runtimeRoot);
          if (state && browserRuntimeId !== null && state.runtimeId === browserRuntimeId) {
            removeAgentAnnotationsBrowserState(runtimeRoot);
          }
        };
        process.once("exit", onExit);
        for (const signal of signals) process.once(signal, onSignal);
        httpServer.once("close", () => {
          process.off("exit", onExit);
          for (const signal of signals) process.off(signal, onSignal);
          cleanupBrowserState();
          void store.close(token);
        });
      }
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://agent-annotations.local");
        if (!url.pathname.startsWith(`${resolvedEndpoint}/`) && url.pathname !== resolvedEndpoint) return next();
        if (!isAgentAnnotationsRequestAllowed(
          request.socket.remoteAddress,
          allowRemote,
          typeof request.headers[TOKEN_HEADER] === "string" ? request.headers[TOKEN_HEADER] : undefined,
          token,
          request
        )) return json(response, 404, { error: "not_found" });
        try {
          if (url.pathname === `${resolvedEndpoint}/task` && request.method === "GET") {
            return json(response, 200, { task: await store.readOrCreate() });
          }
          if (url.pathname === `${resolvedEndpoint}/task` && request.method === "POST") {
            return json(response, 200, {
              task: await store.mutate(
                await body(request) as never,
                sourcePaths.canonicalizeAnnotation
              ),
            });
          }
          if (url.pathname === `${resolvedEndpoint}/revision` && request.method === "GET") {
            const task = store.read();
            return json(response, 200, {
              taskRevision: task?.taskRevision ?? null,
              sourceRevision: task ? sourcePaths.revision(task) : null,
              sourceFiles: task ? sourcePaths.files(task) : [],
            });
          }
          if (url.pathname === `${resolvedEndpoint}/diagnostics` && request.method === "POST") {
            const input = await body(request, MAX_DIAGNOSTICS_BODY_BYTES) as { entries?: unknown };
            return json(response, 200, { entries: appendDiagnostics(runtimeRoot, input.entries) });
          }
          if (url.pathname === `${resolvedEndpoint}/heartbeat` && request.method === "POST") {
            // Only an actually empty body or the exact empty JSON object is the
            // legacy transport liveness heartbeat. Invalid JSON and non-empty
            // unknown shapes are rejected; a claimed browser-state payload
            // (with a schema field) is parsed strictly.
            const raw = await rawBody(request, 16 * 1024);
            const trimmed = raw.trim();
            let parsed: unknown = null;
            if (trimmed !== "") {
              try {
                parsed = JSON.parse(trimmed);
              } catch {
                return json(response, 400, { error: "invalid_json" });
              }
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return json(response, 400, { error: "invalid_heartbeat_payload" });
              }
              const claimed = parsed as Record<string, unknown>;
              if (claimed.schema !== undefined) {
                const state = parseAgentAnnotationsBrowserState(claimed);
                writeAgentAnnotationsBrowserState(runtimeRoot, {
                  ...state,
                  lastHeartbeatAt: new Date().toISOString(),
                });
                browserRuntimeId = state.runtimeId;
              } else if (Object.keys(claimed).length > 0) {
                return json(response, 400, { error: "invalid_heartbeat_payload" });
              }
            }
            return json(response, 200, { ok: true, receivedAt: new Date().toISOString() });
          }
          if (url.pathname === `${resolvedEndpoint}/source` && request.method === "POST") {
            const input = await body(request) as { filePath?: unknown };
            return json(response, 200, {
              filePath: typeof input.filePath === "string"
                ? sourcePaths.canonicalize(input.filePath)
                : null,
            });
          }
          if (url.pathname === `${resolvedEndpoint}/evidence` && request.method === "POST") {
            const input = await body(request, MAX_EVIDENCE_BODY_BYTES) as {
              taskId: string;
              expectedRevision: number;
              annotationId: string;
              png: string;
              width?: number;
              height?: number;
            };
            const bytes = Buffer.from(input.png ?? "", "base64");
            return json(response, 200, {
              task: await store.writeEvidence(
                { taskId: input.taskId, expectedRevision: input.expectedRevision, operations: [] },
                { annotationId: input.annotationId, bytes, mediaType: "image/png", width: input.width, height: input.height }
              ),
            });
          }
          return json(response, 404, { error: "not_found" });
        } catch (error) {
          const code = (error as Error & { code?: string }).code ?? (error as Error).message;
          const task = (error as Error & { task?: unknown; latestTask?: unknown }).task
            ?? (error as Error & { latestTask?: unknown }).latestTask;
          return json(response, code === "revision_conflict" ? 409 : 400, { error: code, ...(task ? { task } : {}) });
        }
      });
    },
  };

  return serverPlugin;
}

export { FileTaskStore } from "../server/store.js";
export { createSourcePathService } from "../server/source-path.js";
