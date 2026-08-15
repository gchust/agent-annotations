import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Plugin } from "vite";

import { FileTaskStore } from "../server/store.js";
import { createSourcePathService } from "../server/source-path.js";

const VIRTUAL_ID = "virtual:agent-annotations/client";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const TOKEN_HEADER = "x-agent-annotations-token";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BODY_BYTES = 3 * 1024 * 1024;
const SOURCE_MODULE = /\.[cm]?[jt]sx?$/i;

export type AgentAnnotationsPluginOptions = {
  root?: string;
  dir?: string;
  endpoint?: string;
  allowRemote?: boolean;
  clientExtensions?: string[];
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
  let root = path.resolve(options.root ?? process.cwd());
  let realRoot = existsSync(root) ? realpathSync(root) : root;
  let runtimeRoot = path.resolve(root, options.dir ?? ".agent-annotations");
  const assertRuntimeRoot = (): void => {
    if (runtimeRoot !== root && !runtimeRoot.startsWith(`${root}${path.sep}`)) {
      throw new Error("agentAnnotations dir must stay inside root");
    }
  };
  assertRuntimeRoot();
  const endpoint = options.endpoint ?? "/__agent-annotations";
  const allowRemote = options.allowRemote === true;
  const extensions = options.clientExtensions ?? [];
  const token = randomBytes(32).toString("hex");
  let sourcePaths = createSourcePathService(root);
  let store = new FileTaskStore(runtimeRoot);
  let closeInstalled = false;
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
    store.writeSession({
      endpoint: resolvedEndpoint,
      origin,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
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
        `import { mountAgentAnnotations } from "@gchust/agent-annotations";`,
        `import { HttpTaskTransport } from "@gchust/agent-annotations/vite/client";`,
        imports,
        `const config = ${JSON.stringify({ endpoint: resolvedEndpoint, token })};`,
        `const extensions = [${values}];`,
        "const key = Symbol.for('agent-annotations.mount');",
        "window[key]?.();",
        "const transport = new HttpTaskTransport(config);",
        "const mounted = await mountAgentAnnotations({ transport, extensions });",
        "window[key] = () => { mounted.unmount(); delete window[key]; };",
        "if (import.meta.hot) {",
        "  import.meta.hot.accept();",
        "  import.meta.hot.dispose(() => window[key]?.());",
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
        const realModule = realpathSync(file);
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
            } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:|^\/\//.test(source)) {
              return;
            } else if (path.isAbsolute(source)) {
              candidate = source;
            } else {
              let base = path.dirname(file);
              if (sourceRoot) {
                if (sourceRoot.startsWith("file:")) {
                  base = fileURLToPath(sourceRoot);
                } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:|^\/\//.test(sourceRoot)) {
                  return;
                } else {
                  base = path.resolve(base, sourceRoot);
                }
              }
              candidate = path.resolve(base, source);
            }
            if (!existsSync(candidate)) return;
            const realSource = realpathSync(candidate);
            if (!statSync(realSource).isFile() || !inside(realRoot, realSource)) return;
            sources.push(pathToFileURL(realSource).href);
          } catch {
            return;
          }
        }
        map.sources.splice(0, map.sources.length, ...sources);
        (map as typeof map & { sourceRoot?: string }).sourceRoot = undefined;
        map.file = file;
        return;
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
        const onExit = () => store.closeSync(token);
        const onSignal = (signal: NodeJS.Signals) => {
          store.closeSync(token);
          process.kill(process.pid, signal);
        };
        process.once("exit", onExit);
        for (const signal of signals) process.once(signal, onSignal);
        httpServer.once("close", () => {
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
            return json(response, 200, { task: store.read() ?? store.create() });
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
          if (url.pathname === `${resolvedEndpoint}/heartbeat` && request.method === "POST") {
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
          const task = (error as Error & { task?: unknown }).task;
          return json(response, code === "revision_conflict" ? 409 : 400, { error: code, ...(task ? { task } : {}) });
        }
      });
    },
  };

  return serverPlugin;
}

export { FileTaskStore } from "../server/store.js";
export { createSourcePathService } from "../server/source-path.js";
