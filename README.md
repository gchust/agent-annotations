# Agent Feedback

Developer-only visual annotations and Code Agent feedback for React/Vite applications.

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
