import { describe, expect, it } from "vitest";

import {
  redactAgentAnnotationsTask,
  redactAgentAnnotationsText,
} from "../../src/core/index.js";
import type { AgentAnnotationsExtensionRedactor } from "../../src/types/index.js";
import { annotationFixture, targetFixture, taskFixture } from "./test-data.js";

describe("generic redaction", () => {
  it("redacts auth, bearer/JWT, cookie, token, password, input value and URL secrets", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
    const values = [
      "Authorization: Bearer auth-secret",
      "Authorization: Basic basic-secret",
      "Bearer bearer-secret",
      jwt,
      "Cookie: session=cookie-secret",
      "token=token-secret",
      "password=password-secret",
      "input_value=input-secret",
      '<input value="input-secret">',
      '{"token":"json-secret"}',
      "https://example.test/path?api_key=url-secret&ok=1",
    ];
    for (const value of values) {
      const result = redactAgentAnnotationsText(value);
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain("secret");
      expect(result).not.toContain(jwt);
    }
    expect(
      redactAgentAnnotationsText(
        "https://example.test/callback?client_secret=client-value&ok=1"
      )
    ).not.toContain("client-value");
  });

  it("runs only the matching extension redactor and preserves namespaces", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          comment: "Bearer comment-secret",
          pageContext: {
            ...annotationFixture().pageContext,
            url: "https://example.test/?token=url-secret",
          },
          targets: [
            targetFixture({
              inspection: {
                ...targetFixture().inspection,
                attributes: { value: "input-secret", title: "safe" },
              },
            }),
          ],
          extensions: {
            "first.context": { password: "drop", keep: "first" },
            "second.context": { keep: "second" },
          },
        }),
      ],
    });
    const result = redactAgentAnnotationsTask(task, [
      {
        extensionId: "first.context",
        id: "only",
        redact: (data) => ({
          ...data,
          host: '<input value="host-secret">',
        }),
      },
    ]);
    expect(result.task.annotations[0].comment).not.toContain("comment-secret");
    expect(result.task.annotations[0].pageContext.url).not.toContain("url-secret");
    expect(result.task.annotations[0].targets?.[0].inspection.attributes).toEqual({
      title: "safe",
    });
    expect(result.task.annotations[0].extensions).toEqual({
      "first.context": {
        keep: "first",
        host: '<input value="[REDACTED]">',
      },
      "second.context": { keep: "second" },
    });
    expect(result.manifest.droppedKeys).toEqual(["password", "value"]);
  });

  it("composes multiple redactors for one extension deterministically by redactor id", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          extensions: {
            "multi.context": { payload: "first" },
            "other.context": { payload: "other" },
          },
        }),
      ],
    });
    const calls: string[] = [];
    const result = redactAgentAnnotationsTask(task, [
      {
        extensionId: "multi.context",
        id: "z-last",
        redact: (data) => {
          calls.push("z-last");
          return { ...data, z: true };
        },
      },
      {
        extensionId: "multi.context",
        id: "a-first",
        redact: (data) => {
          calls.push("a-first");
          return { ...data, a: true };
        },
      },
      {
        extensionId: "other.context",
        id: "only",
        redact: (data) => ({ ...data, other: true }),
      },
    ]);
    expect(calls).toEqual(["a-first", "z-last"]);
    expect(result.task.annotations[0].extensions).toEqual({
      "multi.context": { payload: "first", a: true, z: true },
      "other.context": { payload: "other", other: true },
    });
  });

  it("drops the extension namespace when any composed redactor returns null", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          extensions: {
            "drop.context": { payload: "first" },
          },
        }),
      ],
    });
    const result = redactAgentAnnotationsTask(task, [
      {
        extensionId: "drop.context",
        id: "b-second",
        redact: (data) => ({ ...data, b: true }),
      },
      {
        extensionId: "drop.context",
        id: "a-first",
        redact: () => null,
      },
    ]);
    expect(result.task.annotations[0].extensions).toEqual({});
  });

  it("redacts region target inspections and namespaced extension data", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          kind: "region",
          targets: [
            targetFixture({
              inspection: {
                ...targetFixture().inspection,
                text: "Bearer region-secret",
              },
            }),
          ],
          region: {
            coordinateSpace: "document",
            x: 1,
            y: 2,
            width: 300,
            height: 100,
          },
          extensions: {
            "region.context": { token: "region-token", keep: "yes" },
          },
        }),
      ],
    });
    const result = redactAgentAnnotationsTask(task);
    expect(result.task.annotations[0].targets?.[0].inspection.text).not.toContain("region-secret");
    expect(result.task.annotations[0].targets?.[0].inspection.text).toContain("[REDACTED]");
    expect(result.task.annotations[0].extensions["region.context"]).toEqual({ keep: "yes" });
  });

  it("drops the extension namespace when a composed redactor throws", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          extensions: {
            "broken.context": { keep: "yes", token: "secret" },
            "fine.context": { keep: "yes" },
          },
        }),
      ],
    });
    const result = redactAgentAnnotationsTask(task, [
      {
        extensionId: "broken.context",
        id: "explode",
        redact: () => {
          throw new Error("redactor exploded");
        },
      },
    ]);
    expect(result.task.annotations[0].extensions["broken.context"]).toBeUndefined();
    expect(result.task.annotations[0].extensions["fine.context"]).toEqual({ keep: "yes" });
  });

  it("executes composed redactors in stable (extensionId, redactorId) order", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          extensions: {
            "z.context": { payload: "z" },
            "a.context": { payload: "a" },
          },
        }),
      ],
    });
    const calls: string[] = [];
    const redactor = (extensionId: string, id: string): AgentAnnotationsExtensionRedactor => ({
      extensionId,
      id,
      redact: (data) => {
        calls.push(`${extensionId}/${id}`);
        return data;
      },
    });
    const result = redactAgentAnnotationsTask(task, [
      redactor("z.context", "a"),
      redactor("a.context", "z"),
      redactor("a.context", "a"),
      redactor("z.context", "z"),
    ]);
    expect(calls).toEqual([
      "a.context/a",
      "a.context/z",
      "z.context/a",
      "z.context/z",
    ]);
    expect(result.task.annotations[0].extensions).toEqual({
      "a.context": { payload: "a" },
      "z.context": { payload: "z" },
    });
  });

  it("rejects duplicate extension redactor ids for the same extension deterministically", () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({
          extensions: { "dup.context": { keep: true } },
        }),
      ],
    });
    const redactor = (id: string): AgentAnnotationsExtensionRedactor => ({
      extensionId: "dup.context",
      id,
      redact: (data) => data,
    });
    expect(() => redactAgentAnnotationsTask(task, [redactor("same"), redactor("same")]))
      .toThrow("Duplicate extension redactor: dup.context/same");
    expect(() => redactAgentAnnotationsTask(task, [
      redactor("same"),
      redactor("other"),
      redactor("same"),
    ])).toThrow("Duplicate extension redactor: dup.context/same");
  });
});
