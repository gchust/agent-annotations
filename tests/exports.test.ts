import { describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };
import { agentAnnotationsVersion } from "../src/client/index.js";
import { agentAnnotationsExtensionApiVersion } from "../src/extension/index.js";
import { agentAnnotationsViteEntry } from "../src/vite/index.js";
import type { AgentAnnotationsJsonValue } from "../src/types/index.js";
import { MemoryTaskTransport } from "../src/testing/index.js";

describe("public entry skeleton", () => {
  it("exposes the frozen package version and import sentinels", () => {
    const value: AgentAnnotationsJsonValue = { ready: true };
    expect({
      agentAnnotationsVersion,
      agentAnnotationsExtensionApiVersion,
      agentAnnotationsViteEntry,
      value,
      testing: new MemoryTaskTransport().constructor.name,
    }).toEqual({
      agentAnnotationsVersion: pkg.version,
      agentAnnotationsExtensionApiVersion: 1,
      agentAnnotationsViteEntry: true,
      value: { ready: true },
      testing: "MemoryTaskTransport",
    });
  });
});
