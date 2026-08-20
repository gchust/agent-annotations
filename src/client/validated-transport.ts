import {
  parseValidatedTask,
  validateConflictTask,
} from "../core/transport.js";
import type { TaskTransport } from "../types/index.js";

// Unconditional validation boundary for mountAgentAnnotations: every task
// entering the runtime through read/mutate/writeEvidence/subscribe (including
// the latest task carried by a RevisionConflictError) must pass the strict
// schema parser first. Third-party TaskTransport implementations cannot feed
// an invalid task into the runtime.
export const createValidatedTaskTransport = (transport: TaskTransport): TaskTransport => {
  return {
    read: async () => parseValidatedTask(await transport.read(), "read"),
    mutate: async (request) => {
      try {
        return parseValidatedTask(await transport.mutate(request), "mutate");
      } catch (error) {
        throw validateConflictTask(error);
      }
    },
    writeEvidence: transport.writeEvidence
      ? async (input) => {
          try {
            return parseValidatedTask(await transport.writeEvidence!(input), "writeEvidence");
          } catch (error) {
            throw validateConflictTask(error);
          }
        }
      : undefined,
    subscribe: transport.subscribe
      ? (listener) =>
          transport.subscribe!((task) => listener(parseValidatedTask(task, "subscribe")))
      : undefined,
    appendDiagnostics: transport.appendDiagnostics
      ? (entries) => transport.appendDiagnostics!(entries)
      : undefined,
  };
};
