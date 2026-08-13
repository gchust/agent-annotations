# Agent Feedback

Developer-only visual annotations and Code Agent feedback for React/Vite applications.

## Install

Agent Feedback requires Node 20 or newer, React 19, React DOM 19, and Vite 6:

```sh
pnpm add -D @gchust/agent-feedback
```

The package is ESM-only. Vite is optional when the root runtime is embedded
with a custom `TaskTransport`.

## Vite

Register the development-only plugin; it injects the client automatically, so
the application entry point needs no Agent Feedback code:

```ts
import agentFeedback from "@gchust/agent-feedback/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentFeedback()],
});
```

The package root exports the host-neutral `agent-feedback.task.v1` core and
`mountAgentFeedback()` browser runtime. Public contracts are also available
from `@gchust/agent-feedback/types`; `MemoryTaskTransport` is available only
from `@gchust/agent-feedback/testing` for tests and playgrounds.

## Minimal client extension

Create `src/feedback-extension.ts` using only the public extension entry:

```ts
import { defineClientExtension } from "@gchust/agent-feedback/extension";

export default defineClientExtension({
  id: "example.copy",
  apiVersion: 1,
  toolbar: [{
    id: "copy-open",
    group: "handoff",
    label: "Copy open feedback",
    icon: () => null,
    kind: "action",
    execute: ({ studio }) => studio.commands.annotations.copyOpen(),
  }],
});
```

Register its absolute browser-module path with the Vite plugin:

```ts
import path from "node:path";
import agentFeedback from "@gchust/agent-feedback/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentFeedback({
    clientExtensions: [path.resolve(import.meta.dirname, "src/feedback-extension.ts")],
  })],
});
```

## CLI

The CLI reads `.agent-feedback/tasks/active-task.json`, which always uses
`agent-feedback.task.v1`:

```text
agent-feedback list
agent-feedback complete <annotation-id> --verified --summary <text>
agent-feedback reopen <annotation-id>
agent-feedback print [--json|--markdown]
agent-feedback verify
agent-feedback mcp
agent-feedback audit
```

The MCP server is read-only. It exposes annotation/task reads, diagnostics,
screenshot references, and bounded exact-source revision verification through
`wait_verification({ sourceRevision, timeoutMs? })`; it cannot capture or
create tasks. `audit` enforces the package's single React Grab engine and bans
legacy source fallbacks, basename lookup, old schemas, host coupling, and
built-in Registry bypasses.

## Security

The Vite API binds to loopback by default, requires a random private session
token, and validates Host plus Origin/Referer. Set `allowRemote: true` only on a
trusted development network. Runtime data is stored under `.agent-feedback`;
do not commit it. The client does not collect form values, cookies,
Authorization headers, request bodies, or response bodies, and generic
redaction runs before persistence. The CLI is scoped to that runtime directory
and does not execute shell commands or expose arbitrary file reads.

## API reference

See [API.md](./API.md) for the public root, Vite, extension, types, testing, and
browser-transport entries.

## Limitations

- Development only: production builds exclude the injected runtime and API.
- React 19 and Vite 6 are the supported first-release peer ranges.
- Same-origin iframes and open Shadow Roots are supported; closed Shadow Roots
  and cross-origin frames are reported unresolved.
- Screenshot evidence is best-effort structural evidence, not pixel-perfect
  page capture.
- This alpha uses only `agent-feedback.task.v1`; it does not read or migrate
  previous host-specific schemas, directories, endpoints, or capture tools.
