import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { Plugin } from "vite";

import { FileTaskStore } from "../server/store.js";

const VIRTUAL_ID = "virtual:agent-feedback/client";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const TOKEN_HEADER = "x-agent-feedback-token";
const MAX_BODY_BYTES = 256 * 1024;

export type AgentFeedbackPluginOptions = {
  root?: string;
  dir?: string;
  endpoint?: string;
  allowRemote?: boolean;
  clientExtensions?: string[];
};

export const agentFeedbackViteEntry = true;
export const isAgentFeedbackRequestAllowed = (
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

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export const createSourcePathService = (root: string) => ({
  canonicalize(filePath: string): string | null {
    const absolute = path.resolve(root, filePath);
    return absolute === root || absolute.startsWith(`${root}${path.sep}`)
      ? path.relative(root, absolute).split(path.sep).join("/")
      : null;
  },
});

export default function agentFeedback(
  options: AgentFeedbackPluginOptions = {}
): Plugin {
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(options.endpoint ?? "/__agent-feedback")) {
    throw new Error("agentFeedback endpoint must be a root-relative path");
  }
  let root = path.resolve(options.root ?? process.cwd());
  let runtimeRoot = path.resolve(root, options.dir ?? ".agent-feedback");
  const assertRuntimeRoot = (): void => {
    if (runtimeRoot !== root && !runtimeRoot.startsWith(`${root}${path.sep}`)) {
      throw new Error("agentFeedback dir must stay inside root");
    }
  };
  assertRuntimeRoot();
  const endpoint = options.endpoint ?? "/__agent-feedback";
  const allowRemote = options.allowRemote === true;
  const extensions = options.clientExtensions ?? [];
  const token = randomBytes(32).toString("hex");
  let sourcePaths = createSourcePathService(root);
  let store = new FileTaskStore(runtimeRoot);
  let closeInstalled = false;

  if (allowRemote) {
    console.warn(
      "[agent-feedback] remote access enabled: dev endpoints accept non-loopback clients; the session token is still required"
    );
  }

  const persistSession = (address: ReturnType<NonNullable<import("node:http").Server["address"]>>): void => {
    if (!address || typeof address === "string") return;
    const origin = `http://127.0.0.1:${address.port}`;
    store.writeSession({
      endpoint,
      origin,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
    });
  };

  return {
    name: "agent-feedback",
    apply: "serve",
    configResolved(config) {
      root = path.resolve(options.root ?? config.root);
      runtimeRoot = path.resolve(root, options.dir ?? ".agent-feedback");
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
        `import { mountAgentFeedback } from "@gchust/agent-feedback";`,
        `import { HttpTaskTransport } from "@gchust/agent-feedback/vite/client";`,
        imports,
        `const config = ${JSON.stringify({ endpoint, token })};`,
        `const extensions = [${values}];`,
        "const key = Symbol.for('agent-feedback.mount');",
        "window[key]?.();",
        "const transport = new HttpTaskTransport(config);",
        "const mounted = await mountAgentFeedback({ transport, extensions });",
        "window[key] = () => { mounted.unmount(); delete window[key]; };",
        "if (import.meta.hot) import.meta.hot.dispose(() => window[key]?.());",
      ].filter(Boolean).join("\n");
    },
    transformIndexHtml() {
      return [{
        tag: "script",
        attrs: {
          type: "module",
          src: "/@id/__x00__virtual:agent-feedback/client",
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
        const url = new URL(request.url ?? "/", "http://agent-feedback.local");
        if (!url.pathname.startsWith(`${endpoint}/`) && url.pathname !== endpoint) return next();
        if (!isAgentFeedbackRequestAllowed(
          request.socket.remoteAddress,
          allowRemote,
          typeof request.headers[TOKEN_HEADER] === "string" ? request.headers[TOKEN_HEADER] : undefined,
          token,
          request
        )) return json(response, 404, { error: "not_found" });
        try {
          if (url.pathname === `${endpoint}/task` && request.method === "GET") {
            return json(response, 200, { task: store.read() ?? store.create() });
          }
          if (url.pathname === `${endpoint}/task` && request.method === "POST") {
            return json(response, 200, { task: await store.mutate(await body(request) as never) });
          }
          if (url.pathname === `${endpoint}/revision` && request.method === "GET") {
            return json(response, 200, { taskRevision: store.read()?.taskRevision ?? null });
          }
          if (url.pathname === `${endpoint}/heartbeat` && request.method === "POST") {
            return json(response, 200, { ok: true, receivedAt: new Date().toISOString() });
          }
          if (url.pathname === `${endpoint}/source` && request.method === "POST") {
            const input = await body(request) as { filePath?: unknown };
            return json(response, 200, {
              filePath: typeof input.filePath === "string"
                ? sourcePaths.canonicalize(input.filePath)
                : null,
            });
          }
          if (url.pathname === `${endpoint}/evidence` && request.method === "POST") {
            const input = await body(request) as {
              taskId: string;
              expectedRevision: number;
              annotationId: string;
              png: string;
            };
            const bytes = Buffer.from(input.png ?? "", "base64");
            return json(response, 200, {
              task: await store.writeEvidence(
                { taskId: input.taskId, expectedRevision: input.expectedRevision, operations: [] },
                { annotationId: input.annotationId, bytes, mediaType: "image/png" }
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
}

export { FileTaskStore } from "../server/store.js";
