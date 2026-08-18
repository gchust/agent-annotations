# Agent Annotations

Developer-only visual annotations handed to Code Agents in React/Vite applications.

## Install

Agent Annotations requires Node 20 or newer, React 19, React DOM 19, and Vite 6:

```sh
pnpm add -D @gchust/agent-annotations
```

The package is ESM-only. Vite is optional when the root runtime is embedded
with a custom `TaskTransport`.

## Vite

Register the development-only plugin; it injects the client automatically, so
the application entry point needs no Agent Annotations code:

```ts
import agentAnnotations from "@gchust/agent-annotations/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentAnnotations()],
});
```

The package root exports the host-neutral `agent-annotations.task.v1` core and
`mountAgentAnnotations()` browser runtime. Public contracts are also available
from `@gchust/agent-annotations/types`; `MemoryTaskTransport` is available only
from `@gchust/agent-annotations/testing` for tests and playgrounds.

## Minimal client extension

Create `src/annotation-extension.ts` using only the public extension entry:

```ts
import { defineClientExtension } from "@gchust/agent-annotations/extension";

export default defineClientExtension({
  id: "example.copy",
  apiVersion: 1,
  toolbar: [{
    id: "copy-open",
    group: "handoff",
    label: "Copy open annotations",
    icon: () => null,
    kind: "action",
    execute: ({ studio }) => studio.commands.annotations.copyOpen(),
  }],
});
```

Register its absolute browser-module path with the Vite plugin:

```ts
import path from "node:path";
import agentAnnotations from "@gchust/agent-annotations/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentAnnotations({
    clientExtensions: [path.resolve(import.meta.dirname, "src/annotation-extension.ts")],
  })],
});
```

## CLI

The CLI reads `.agent-annotations/tasks/active-task.json`, which always uses
`agent-annotations.task.v1`:

```text
agent-annotations list
agent-annotations complete <annotation-id> --verified --summary <text>
agent-annotations reopen <annotation-id>
agent-annotations print [--json|--markdown]
agent-annotations verify
agent-annotations audit
```

`audit` enforces the package's single React Grab engine and bans legacy source
fallbacks, basename lookup, old schemas, host coupling, and built-in Registry
bypasses.

## Security

The Vite API binds to loopback by default, requires a random private session
token, and validates Host plus Origin/Referer. Set `allowRemote: true` only on a
trusted development network. Runtime data is stored under `.agent-annotations`;
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
- This alpha uses only `agent-annotations.task.v1`; it does not read or migrate
  previous host-specific schemas, directories, endpoints, or capture tools.
