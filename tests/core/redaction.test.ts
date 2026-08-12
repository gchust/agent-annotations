import { describe, expect, it } from "vitest";

import {
  redactAgentFeedbackTask,
  redactAgentFeedbackText,
} from "../../src/core/index.js";
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
      "https://example.test/path?api_key=url-secret&ok=1",
    ];
    for (const value of values) {
      const result = redactAgentFeedbackText(value);
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain("secret");
      expect(result).not.toContain(jwt);
    }
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
    const result = redactAgentFeedbackTask(task, [
      {
        extensionId: "first.context",
        redact: (data) => ({ ...data, host: "filtered" }),
      },
    ]);
    expect(result.task.annotations[0].comment).not.toContain("comment-secret");
    expect(result.task.annotations[0].pageContext.url).not.toContain("url-secret");
    expect(result.task.annotations[0].targets?.[0].inspection.attributes).toEqual({
      title: "safe",
    });
    expect(result.task.annotations[0].extensions).toEqual({
      "first.context": { keep: "first", host: "filtered" },
      "second.context": { keep: "second" },
    });
    expect(result.manifest.droppedKeys).toEqual(["password", "value"]);
  });
});
