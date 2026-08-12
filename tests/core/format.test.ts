import { describe, expect, it } from "vitest";

import {
  formatAgentFeedbackTask,
  formatAgentFeedbackTaskMarkdown,
} from "../../src/core/index.js";
import { annotationFixture, targetFixture, taskFixture } from "./fixtures.js";

describe("shared formatter", () => {
  const task = taskFixture({
    annotations: [
      annotationFixture({
        annotationId: "ann-1",
        status: "completed",
        completedAt: "2026-08-12T12:02:00.000Z",
        extensions: { "demo.context": { ticket: "AF-2" } },
      }),
      annotationFixture({
        annotationId: "ann-2",
        kind: "multi",
        comment: "Align both buttons",
        targets: [targetFixture(), targetFixture({ selector: "main > a" })],
      }),
      annotationFixture({
        annotationId: "ann-3",
        kind: "region",
        comment: "Reduce whitespace",
        targets: undefined,
        region: {
          coordinateSpace: "document",
          x: 1,
          y: 2,
          width: 300,
          height: 100,
        },
      }),
    ],
  });

  it("goldens open single/multi/region output", () => {
    expect(formatAgentFeedbackTaskMarkdown(task)).toMatchInlineSnapshot(`
      "# Agent Feedback Task task-1

      - schema: agent-feedback.task.v1
      - schemaVersion: 1
      - revision: 0
      - status: active
      - createdAt: 2026-08-12T12:00:00.000Z
      - updatedAt: 2026-08-12T12:00:00.000Z

      ## Annotations (2)

      ### Annotation 2: [multi] ann-2

      Comment: Align both buttons

      - status: open
      - page: /settings (Settings)

      #### Target 1

      - selector: main > button
      - bounds: 10,20 120x32
      - element: <button>
      - component: SaveButton
      - source: src/pages/settings.tsx:12:4 (SaveButton)
      - source stack:
        - src/pages/settings.tsx:12:4 (SaveButton)

      #### Target 2

      - selector: main > a
      - bounds: 10,20 120x32
      - element: <button>
      - component: SaveButton
      - source: src/pages/settings.tsx:12:4 (SaveButton)
      - source stack:
        - src/pages/settings.tsx:12:4 (SaveButton)

      ### Annotation 3: [region] ann-3

      Comment: Reduce whitespace

      - status: open
      - page: /settings (Settings)
      - region: 1,2 300x100
      "
    `);
  });

  it("goldens all mode with single target and extension context", () => {
    const all = formatAgentFeedbackTaskMarkdown(task, { annotations: "all" });
    expect(all).toContain(`## Annotations (3)

### Annotation 1: [element] ann-1`);
    expect(all).toContain(`#### Target

- selector: main > button`);
    expect(all).toContain(`#### Extension context

- demo.context: {"ticket":"AF-2"}`);
    expect(all).toContain("### Annotation 2: [multi] ann-2");
    expect(all).toContain("### Annotation 3: [region] ann-3");
  });

  it("supports the JSON public formatter", () => {
    expect(JSON.parse(formatAgentFeedbackTask(task, { format: "json" }))).toEqual(task);
  });
});
