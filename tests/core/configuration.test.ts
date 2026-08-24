import { describe, expect, it } from "vitest";

import {
  validateAgentAnnotationsBuiltinsConfig,
  validateAgentAnnotationsInitialState,
} from "../../src/core/configuration.js";

describe("builtins configuration", () => {
  it("accepts empty, boolean flags, and strict shortcut overrides", () => {
    expect(validateAgentAnnotationsBuiltinsConfig(undefined)).toEqual({});
    expect(validateAgentAnnotationsBuiltinsConfig({ pick: false, clear: true, list: true }))
      .toEqual({ pick: false, clear: true, list: true });
    expect(validateAgentAnnotationsBuiltinsConfig({
      shortcuts: {
        pick: { key: "X", code: "KeyX", primary: true, alt: true, shift: false },
        multi: false,
      },
    })).toEqual({
      shortcuts: {
        pick: { key: "X", code: "KeyX", primary: true, alt: true, shift: false },
        multi: false,
      },
    });
  });

  it("rejects unknown keys and non-boolean flags", () => {
    expect(() => validateAgentAnnotationsBuiltinsConfig({ audit: true }))
      .toThrow("unknown builtins option: audit");
    expect(() => validateAgentAnnotationsBuiltinsConfig({ pick: "yes" }))
      .toThrow("builtins pick must be a boolean");
    expect(() => validateAgentAnnotationsBuiltinsConfig(new Date()))
      .toThrow("builtins must be a plain object or false");
    expect(() => validateAgentAnnotationsBuiltinsConfig([]))
      .toThrow("builtins must be a plain object or false");
  });

  it("normalizes shortcuts into fresh exact objects so toJSON or later mutation cannot leak", () => {
    const sneaky = { key: "P", code: "KeyP", primary: true, alt: true, shift: false };
    Object.defineProperty(sneaky, "toJSON", {
      value: () => ({ hacked: true }),
      enumerable: false,
    });
    let getterCalls = 0;
    Object.defineProperty(sneaky, "key", {
      get: () => {
        getterCalls += 1;
        return "P";
      },
      enumerable: true,
    });
    const input = { shortcuts: { pick: sneaky } };
    const normalized = validateAgentAnnotationsBuiltinsConfig(input);
    const callsAfterValidation = getterCalls;
    (sneaky as Record<string, unknown>).injected = "evil";
    expect(JSON.stringify(normalized.shortcuts)).toBe(
      JSON.stringify({ pick: { key: "P", code: "KeyP", primary: true, alt: true, shift: false } })
    );
    // Serializing the normalized output never touches the original getter,
    // and neither toJSON nor later host mutation can leak into it.
    expect(getterCalls).toBe(callsAfterValidation);
    expect(JSON.stringify(normalized.shortcuts)).not.toContain("evil");
    expect(JSON.stringify(normalized.shortcuts)).not.toContain("hacked");
  });

  it("rejects JSON-unsafe shortcut values and shapes", () => {
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { pick: () => undefined },
    })).toThrow(/must be a plain object or false/);
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { bogus: { key: "P", primary: true, alt: true, shift: false } },
    })).toThrow("unknown builtins shortcut: bogus");
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { pick: { key: "", primary: true, alt: true, shift: false } },
    })).toThrow("pick.key must be a non-empty string");
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { pick: { key: "P" } },
    })).toThrow("pick.primary must be a boolean");
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { pick: { key: "P", primary: true, alt: true, shift: "no" } },
    })).toThrow("pick.shift must be a boolean");
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { pick: { key: "P", primary: true, alt: true, shift: false, code: 7 } },
    })).toThrow("pick.code must be a non-empty string");
    expect(() => validateAgentAnnotationsBuiltinsConfig({
      shortcuts: { pick: { key: "P", primary: true, alt: true, shift: false, extra: 1 } },
    })).toThrow("unknown builtins shortcut field: pick.extra");
  });
});

describe("initialState configuration", () => {
  it("accepts booleans only and rejects unknown keys", () => {
    expect(validateAgentAnnotationsInitialState(undefined)).toEqual({});
    expect(validateAgentAnnotationsInitialState({ collapsed: false, markersVisible: false }))
      .toEqual({ collapsed: false, markersVisible: false });
    expect(() => validateAgentAnnotationsInitialState({ collapsed: "yes" }))
      .toThrow("initialState collapsed must be a boolean");
    expect(() => validateAgentAnnotationsInitialState({ open: true }))
      .toThrow("unknown initialState option: open");
    expect(() => validateAgentAnnotationsInitialState([]))
      .toThrow("initialState must be a plain object");
  });
});
