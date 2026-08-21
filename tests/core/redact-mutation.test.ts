import { describe, expect, it } from "vitest";

import {
  applyAgentAnnotationsMutation,
  prepareAgentAnnotationsTaskForPersistence,
  redactAgentAnnotationsMutationRequest,
  redactAgentAnnotationsTask,
} from "../../src/core/index.js";
import type { AgentAnnotationsExtensionRedactor } from "../../src/types/index.js";
import { annotationFixture, targetFixture, taskFixture } from "./test-data.js";

const redactors: AgentAnnotationsExtensionRedactor[] = [
  {
    extensionId: "demo.extension",
    id: "scrub",
    redact: (data) => ({
      ...data,
      host: '<input value="host-secret">',
    }),
  },
];

describe("redactAgentAnnotationsMutationRequest", () => {
  it("redacts add annotation text, html, style, attributes, and extension data", () => {
    const task = taskFixture();
    const operation = {
      op: "add" as const,
      annotation: annotationFixture({
        annotationId: "ann-2",
        comment: "Bearer add-secret",
        targets: [targetFixture({
          inspection: {
            ...targetFixture().inspection,
            text: "Bearer text-secret",
            htmlPreview: "Bearer html-secret",
            styleText: "Bearer style-secret",
            attributes: { value: "input-secret", title: "safe" },
          },
        })],
        extensions: {
          "demo.extension": { token: "ext-secret", keep: "yes" },
        },
      }),
    };
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [operation],
    }, redactors);
    const annotation = (redacted.operations[0] as typeof operation).annotation;
    expect(annotation.comment).not.toContain("add-secret");
    expect(annotation.targets![0].inspection.text).not.toContain("text-secret");
    expect(annotation.targets![0].inspection.htmlPreview).not.toContain("html-secret");
    expect(annotation.targets![0].inspection.styleText).not.toContain("style-secret");
    expect(annotation.targets![0].inspection.attributes).toEqual({
      title: "safe",
    });
    expect(annotation.extensions["demo.extension"]).toEqual({
      keep: "yes",
      host: '<input value="[REDACTED]">',
    });
    expect(JSON.stringify(redacted)).not.toContain("secret");
  });

  it("redacts update comments", () => {
    const task = taskFixture();
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "update", annotationId: "ann-1", comment: "Bearer update-secret" }],
    });
    expect((redacted.operations[0] as { comment: string }).comment).toContain("[REDACTED]");
    expect((redacted.operations[0] as { comment: string }).comment).not.toContain("update-secret");
  });

  it("redacts completion summaries and sources", () => {
    const task = taskFixture();
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{
        op: "complete",
        annotationId: "ann-1",
        evidence: {
          verified: true,
          summary: "Bearer summary-secret",
          source: "Bearer source-secret",
        },
      }],
    });
    const evidence = (redacted.operations[0] as { evidence: { summary: string; source: string } }).evidence;
    expect(evidence.summary).not.toContain("summary-secret");
    expect(evidence.summary).toContain("[REDACTED]");
    expect(evidence.source).not.toContain("source-secret");
    expect(evidence.source).toContain("[REDACTED]");
  });

  it("redacts setExtension secret keys and values through the extension pipeline", () => {
    const task = taskFixture();
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{
        op: "setExtension",
        annotationId: "ann-1",
        extensionId: "demo.extension",
        data: { token: "Bearer ext-secret", keep: "keep", nested: { password: "drop" } },
      }],
    }, redactors);
    const data = (redacted.operations[0] as { data: Record<string, unknown> }).data;
    // Secret keys are dropped by generic redaction, values are redacted.
    expect(data).not.toHaveProperty("token");
    expect(JSON.stringify(data)).not.toContain("ext-secret");
    expect(JSON.stringify(data)).not.toContain("password");
    expect(data).toMatchObject({ keep: "keep", host: expect.stringContaining("[REDACTED]") });
  });

  it("redacts addEvidence string metadata and keeps numeric fields", () => {
    const task = taskFixture();
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{
        op: "addEvidence",
        annotationId: "ann-1",
        evidence: {
          kind: "screenshot",
          ref: "Bearer evidence-ref-secret",
          mediaType: "Bearer media-secret",
          width: 1600,
          height: 900,
          capturedAt: "2026-08-12T12:00:00.000Z",
        },
      }],
    });
    const evidence = (redacted.operations[0] as { evidence: { ref: string; mediaType: string; capturedAt: string; width: number; height: number } }).evidence;
    expect(evidence.ref).not.toContain("evidence-ref-secret");
    expect(evidence.mediaType).not.toContain("media-secret");
    // capturedAt is structural and must stay a valid timestamp.
    expect(evidence.capturedAt).toBe("2026-08-12T12:00:00.000Z");
    expect(evidence.width).toBe(1600);
    expect(evidence.height).toBe(900);
  });

  it("keeps data-less operations unchanged and revalidates the redacted request", () => {
    const task = taskFixture();
    const operations = [
      { op: "reopen" as const, annotationId: "ann-1" },
      { op: "remove" as const, annotationId: "ann-1" },
      { op: "removeCompleted" as const },
    ];
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations,
    });
    expect(redacted.operations).toEqual(operations);
  });

  it("runs extension redactors in stable order and fails closed on faulty redactors", () => {
    const task = taskFixture({
      annotations: [annotationFixture({ extensions: { "broken.context": { keep: "yes", token: "secret" } } })],
    });
    const calls: string[] = [];
    const redactors: AgentAnnotationsExtensionRedactor[] = [
      {
        extensionId: "broken.context",
        id: "z-last",
        redact: (data) => {
          calls.push("z-last");
          return data;
        },
      },
      {
        extensionId: "broken.context",
        id: "a-first",
        redact: (data) => {
          calls.push("a-first");
          return data;
        },
      },
      {
        extensionId: "broken.context",
        id: "explode",
        redact: () => {
          calls.push("explode");
          throw new Error("redactor exploded");
        },
      },
    ];
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{
        op: "setExtension",
        annotationId: "ann-1",
        extensionId: "broken.context",
        data: { token: "Bearer ext-secret", keep: "yes" },
      }],
    }, redactors);
    // Stable order is (extensionId, redactorId): a-first, explode, z-last;
    // the faulty redactor stops the pipeline and fails closed.
    expect(calls).toEqual(["a-first", "explode"]);
    // Fail closed: the faulty namespace never reaches the delegate.
    const data = (redacted.operations[0] as { data: Record<string, unknown> }).data;
    expect(JSON.stringify(data)).not.toContain("ext-secret");
  });

  it("rejects requests that target unknown annotations (fail closed)", () => {
    const task = taskFixture();
    expect(() => redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "update", annotationId: "missing", comment: "Bearer secret" }],
    })).toThrow(TypeError);
    expect(() => redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{
        op: "setExtension",
        annotationId: "missing",
        extensionId: "demo.extension",
        data: { token: "secret" },
      }],
    })).toThrow(TypeError);
  });

  it("rejects structurally invalid requests", () => {
    const task = taskFixture();
    expect(() => redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "bogus" as never }],
    })).toThrow(TypeError);
    expect(() => redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: { invalid: true } as never }],
    })).toThrow(TypeError);
  });

  it("rejects redacted payloads that no longer pass schema validation", () => {
    const task = taskFixture({
      annotations: [annotationFixture({ extensions: { "demo.extension": { keep: "yes" } } })],
    });
    const badRedactor: AgentAnnotationsExtensionRedactor = {
      extensionId: "demo.extension",
      id: "bad",
      redact: () => ({ tooLong: "x".repeat(8_001) }),
    };
    expect(() => redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{
        op: "setExtension",
        annotationId: "ann-1",
        extensionId: "demo.extension",
        data: { token: "secret" },
      }],
    }, [badRedactor])).toThrow(TypeError);
  });
});

describe("prepareAgentAnnotationsTaskForPersistence", () => {
  it("parses, generically redacts, and re-parses without extension redactors", () => {
    const input = taskFixture({
      annotations: [annotationFixture({
        comment: "Bearer persistence-secret",
        extensions: { "demo.extension": { token: "ext-secret" } },
        evidence: [{ kind: "screenshot", ref: "Bearer ref-secret" }],
      })],
    });
    const prepared = prepareAgentAnnotationsTaskForPersistence(input);
    expect(prepared.annotations[0].comment).not.toContain("persistence-secret");
    expect(JSON.stringify(prepared)).not.toContain("ext-secret");
    expect(JSON.stringify(prepared)).not.toContain("ref-secret");
    // Idempotent: a second pass is byte-stable.
    expect(prepareAgentAnnotationsTaskForPersistence(prepared)).toEqual(prepared);
  });

  it("rejects invalid input during the parse step", () => {
    expect(() => prepareAgentAnnotationsTaskForPersistence({ invalid: true })).toThrow();
  });

  it("gives custom persistent transports a single safe persistence path", () => {
    class CustomPersistentTransport {
      saved: unknown = null;
      persist(task: unknown): void {
        this.saved = prepareAgentAnnotationsTaskForPersistence(task);
      }
    }
    const transport = new CustomPersistentTransport();
    transport.persist(taskFixture({
      annotations: [annotationFixture({ comment: "Bearer disk-secret" })],
    }));
    expect(JSON.stringify(transport.saved)).not.toContain("disk-secret");
    // The saved task is the same redaction the runtime's own store applies.
    expect(transport.saved).toEqual(redactAgentAnnotationsTask(taskFixture({
      annotations: [annotationFixture({ comment: "Bearer disk-secret" })],
    })).task);
    // And applying a mutation on top of the prepared task stays clean.
    const next = applyAgentAnnotationsMutation(transport.saved as never, {
      taskId: (transport.saved as { taskId: string }).taskId,
      expectedRevision: 0,
      operations: [{
        op: "update",
        annotationId: "ann-1",
        comment: "Bearer second-secret",
      }],
    }, new Date().toISOString());
    if (!next.ok) throw new Error(`mutation failed: ${next.error}`);
    // Persisting a mutation result through the official helper stays clean.
    const preparedNext = prepareAgentAnnotationsTaskForPersistence(next.task);
    expect(JSON.stringify(preparedNext)).not.toContain("second-secret");
  });
});

describe("sequential mutation semantics", () => {
  it("redacts a setExtension targeting an annotation added earlier in the same request", () => {
    const task = taskFixture();
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [
        {
          op: "add",
          annotation: annotationFixture({
            annotationId: "ann-new",
            comment: "Bearer added-secret",
          }),
        },
        {
          op: "setExtension",
          annotationId: "ann-new",
          extensionId: "demo.extension",
          data: { token: "Bearer ext-secret", keep: "yes" },
        },
      ],
    }, redactors);
    const addOp = redacted.operations[0] as { op: "add"; annotation: { comment: string } };
    const setOp = redacted.operations[1] as { op: "setExtension"; data: Record<string, unknown> };
    expect(addOp.annotation.comment).not.toContain("added-secret");
    expect(JSON.stringify(setOp.data)).not.toContain("ext-secret");
    expect(setOp.data).toMatchObject({ keep: "yes", host: expect.stringContaining("[REDACTED]") });
    // The whole redacted request must still apply sequentially and validly.
    const applied = applyAgentAnnotationsMutation(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: redacted.operations,
    }, new Date().toISOString());
    expect(applied.ok).toBe(true);
  });

  it("allows update and complete to target an annotation added earlier in the same request", () => {
    const task = taskFixture();
    const redacted = redactAgentAnnotationsMutationRequest(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [
        { op: "add", annotation: annotationFixture({ annotationId: "ann-new" }) },
        { op: "update", annotationId: "ann-new", comment: "Bearer update-secret" },
        {
          op: "complete",
          annotationId: "ann-new",
          evidence: { verified: true, summary: "Bearer summary-secret", source: "test" },
        },
      ],
    });
    const updateOp = redacted.operations[1] as { op: "update"; comment: string };
    const completeOp = redacted.operations[2] as { op: "complete"; evidence: { summary: string } };
    expect(updateOp.comment).not.toContain("update-secret");
    expect(completeOp.evidence.summary).not.toContain("summary-secret");
    const applied = applyAgentAnnotationsMutation(task, {
      taskId: task.taskId,
      expectedRevision: 0,
      operations: redacted.operations,
    }, new Date().toISOString());
    expect(applied.ok).toBe(true);
  });
});
