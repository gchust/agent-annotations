// Type probe: the README examples compile against the real public types
// (checked by `pnpm typecheck`, which includes tests/). The Vite config
// example uses the plugin's `agentAnnotations`, the extension example uses
// `defineClientExtension` + a declared TaskTransport, and the manual-runtime
// example uses declared task/persist placeholders.
import agentAnnotations from "../../src/vite/index.js";
import { defineClientExtension } from "../../src/extension/index.js";
import {
  mountAgentAnnotations,
  createValidatedTaskTransport,
  type AgentAnnotationsMutationRequest,
  type AgentAnnotationsTask,
  type TaskTransport,
} from "../../src/client/index.js";

// Vite plugin configuration example (builtins/initialState/screenshotEvidence/diagnostics).
const plugin = agentAnnotations({
  clientExtensions: ["./src/annotation-extension.ts"],
  builtins: { help: false },
  initialState: { collapsed: true, markersVisible: true },
  screenshotEvidence: "auto",
  diagnostics: { console: true, network: true },
});
void plugin;

// Extension quick-start example with a declared custom transport.
declare const myTransport: TaskTransport;
const localeHost = defineClientExtension({
  id: "host",
  apiVersion: 1,
  host: {
    locale: () => "zh-CN",
    messages: { "Pick": "Select" },
  },
});
const mounted = await mountAgentAnnotations({
  transport: myTransport,
  extensions: [localeHost],
});
mounted.unmount();

// Manual runtime / custom transport example.
declare const task: AgentAnnotationsTask;
declare const persistMutation: (
  request: AgentAnnotationsMutationRequest
) => Promise<AgentAnnotationsTask>;
const mountedManual = await mountAgentAnnotations({
  transport: createValidatedTaskTransport({
    read: async () => task,
    mutate: persistMutation,
  }),
});
mountedManual.unmount();
