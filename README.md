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
