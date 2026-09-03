import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Plugin } from "vite";
import type {
  AgentAnnotationsBuiltinsConfig,
  AgentAnnotationsDiagnosticsConfig,
  AgentAnnotationsHandoffConfig,
  AgentAnnotationsInitialState,
} from "../types/index.js";

import { FileTaskStore } from "../server/store.js";
import { appendDiagnostics } from "../server/diagnostics.js";
import { createSourcePathService } from "../server/source-path.js";
import { validateAgentAnnotationsHandoffConfig } from "../core/handoff.js";
import {
  validateAgentAnnotationsBuiltinsConfig,
  validateAgentAnnotationsDiagnosticsConfig,
  validateAgentAnnotationsInitialState,
} from "../core/configuration.js";
import { PACKAGE_NAME } from "../metadata.js";

const VIRTUAL_ID = "virtual:agent-annotations/client";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const TOKEN_HEADER = "x-agent-annotations-token";
const TASK_UPDATE_EVENT = "agent-annotations:task-update";
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
  builtins?: false | AgentAnnotationsBuiltinsConfig;
  initialState?: AgentAnnotationsInitialState;
  diagnostics?: AgentAnnotationsDiagnosticsConfig;
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
  // JSON-safe builtins/initialState config: only booleans and plain objects
  // reach the virtual client.
  const builtins = options.builtins === false
    ? false
    : validateAgentAnnotationsBuiltinsConfig(options.builtins);
  const initialState = validateAgentAnnotationsInitialState(options.initialState);
  const diagnostics = validateAgentAnnotationsDiagnosticsConfig(options.diagnostics);
  let root = path.resolve(options.root ?? process.cwd());
  let realRoot = existsSync(root) ? realpathSync.native(root) : root;
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
  let taskWatcher: FSWatcher | undefined;
  let viteBase = "/";
  let resolvedEndpoint = endpoint;

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
      runtimeRoot: realpathSync.native(runtimeRoot),
    });
  };

  const serverPlugin: Plugin = {
    name: "agent-annotations",
    apply: "serve",
    configResolved(config) {
      viteBase = config.base;
      resolvedEndpoint = `${viteBase.replace(/\/$/, "")}${endpoint}`;
      root = path.resolve(options.root ?? config.root);
      realRoot = realpathSync.native(root);
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
        `const config = ${JSON.stringify({ endpoint: resolvedEndpoint, token, screenshotEvidence, handoff, builtins, initialState, diagnostics })};`,
        `const extensions = [${values}];`,
        "const key = Symbol.for('agent-annotations.mount');",
        "let mounted;",
        "let taskUpdatePending = false;",
        `const onTaskUpdate = () => { if (mounted) window.dispatchEvent(new Event(${JSON.stringify(TASK_UPDATE_EVENT)})); else taskUpdatePending = true; };`,
        `if (import.meta.hot) import.meta.hot.on(${JSON.stringify(TASK_UPDATE_EVENT)}, onTaskUpdate);`,
        "window[key]?.();",
        "const transport = new HttpTaskTransport(config);",
        `mounted = await mountAgentAnnotations({ transport, extensions, screenshotEvidence: config.screenshotEvidence, handoff: config.handoff, builtins: config.builtins, initialState: config.initialState, diagnostics: config.diagnostics });`,
        `if (taskUpdatePending) window.dispatchEvent(new Event(${JSON.stringify(TASK_UPDATE_EVENT)}));`,
        "const onPageHide = () => window[key]?.();",
        "window.addEventListener('pagehide', onPageHide, { once: true });",
        "window[key] = () => { window.removeEventListener('pagehide', onPageHide); mounted.unmount(); delete window[key]; };",
        "if (import.meta.hot) {",
        "  import.meta.hot.accept();",
        `  import.meta.hot.dispose(() => { import.meta.hot.off(${JSON.stringify(TASK_UPDATE_EVENT)}, onTaskUpdate); window[key]?.(); });`,
        "}",
      ].filter(Boolean).join("\n");
    },
    transform: {
      order: "post",
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
        const realModule = realpathSync.native(file);
        if (!statSync(realModule).isFile() || !inside(realRoot, realModule)) return;
        const map = this.getCombinedSourcemap();
        if (!map?.version || !map.sources.length) return;
        const sourceRoot = (map as typeof map & { sourceRoot?: string }).sourceRoot;
        const sources: string[] = [];
        for (const source of map.sources) {
          let candidate: string;
          try {
            if (source.startsWith("file:")) {
              candidate = fileURLToPath(source);
            } else if (path.isAbsolute(source)) {
              candidate = source;
            } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:|^\/\//.test(source)) {
              return;
            } else {
              let base = path.dirname(file);
              if (sourceRoot) {
                if (sourceRoot.startsWith("file:")) {
                  base = fileURLToPath(sourceRoot);
                } else if (path.isAbsolute(sourceRoot)) {
                  base = sourceRoot;
                } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:|^\/\//.test(sourceRoot)) {
                  return;
                } else {
                  base = path.resolve(base, sourceRoot);
                }
              }
              candidate = path.resolve(base, source);
            }
            if (!existsSync(candidate)) return;
            const realSource = realpathSync.native(candidate);
            if (!statSync(realSource).isFile() || !inside(realRoot, realSource)) return;
            sources.push(pathToFileURL(realSource).href);
          } catch {
            return;
          }
        }
        map.sources.splice(0, map.sources.length, ...sources);
        (map as typeof map & { sourceRoot?: string }).sourceRoot = undefined;
        map.file = file;
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
      mkdirSync(path.dirname(store.taskPath), { recursive: true, mode: 0o700 });
      taskWatcher?.close();
      taskWatcher = watch(path.dirname(store.taskPath), (_event, filename) => {
        if (filename?.toString() !== path.basename(store.taskPath)) return;
        server.ws.send({ type: "custom", event: TASK_UPDATE_EVENT });
      });
      const listening = () => persistSession(httpServer?.address() ?? null);
      if (httpServer?.listening) listening();
      else httpServer?.once("listening", listening);
      if (httpServer && !closeInstalled) {
        closeInstalled = true;
        const signals = ["SIGINT", "SIGTERM"] as const;
        const onExit = () => {
          store.closeSync(token);
        };
        const onSignal = (signal: NodeJS.Signals) => {
          store.closeSync(token);
          process.kill(process.pid, signal);
        };
        process.once("exit", onExit);
        for (const signal of signals) process.once(signal, onSignal);
        httpServer.once("close", () => {
          taskWatcher?.close();
          taskWatcher = undefined;
          process.off("exit", onExit);
          for (const signal of signals) process.off(signal, onSignal);
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
          if (url.pathname === `${resolvedEndpoint}/diagnostics` && request.method === "POST") {
            const input = await body(request, MAX_DIAGNOSTICS_BODY_BYTES) as { entries?: unknown };
            return json(response, 200, { entries: await appendDiagnostics(runtimeRoot, input.entries) });
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
          return json(response, code === "revision_conflict" ? 409 : 400, {
            error: code,
            ...(task ? { task } : {}),
          });
        }
      });
    },
  };

  return serverPlugin;
}

export { FileTaskStore } from "../server/store.js";
export { createSourcePathService } from "../server/source-path.js";
