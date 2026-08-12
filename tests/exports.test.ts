import { describe, expect, it } from "vitest";
import { agentFeedbackVersion } from "../src/client/index.js";
import { agentFeedbackExtensionApiVersion } from "../src/extension/index.js";
import { agentFeedbackViteEntry } from "../src/vite/index.js";
import type { AgentFeedbackJsonValue } from "../src/types/index.js";
import { MemoryTaskTransport } from "../src/testing/index.js";

describe("public entry skeleton", () => {
  it("exposes the frozen package version and import sentinels", () => {
    const value: AgentFeedbackJsonValue = { ready: true };
    expect({
      agentFeedbackVersion,
      agentFeedbackExtensionApiVersion,
      agentFeedbackViteEntry,
      value,
      testing: new MemoryTaskTransport().constructor.name,
    }).toEqual({
      agentFeedbackVersion: "0.1.0-alpha.0",
      agentFeedbackExtensionApiVersion: 1,
      agentFeedbackViteEntry: true,
      value: { ready: true },
      testing: "MemoryTaskTransport",
    });
  });
});
