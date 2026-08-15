import { describe, expect, it } from "vitest";

import {
  formatAgentAnnotationsTask,
  formatAgentAnnotationsTaskMarkdown,
} from "../../src/core/index.js";
import { annotationFixture, targetFixture, taskFixture } from "./test-data.js";

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
    expect(formatAgentAnnotationsTaskMarkdown(task)).toMatchInlineSnapshot(`
      "# Agent Annotations Task task-1

      - schema: agent-annotations.task.v1
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
    const completedAt = "2026-08-12T12:02:00.000Z";
    const single = taskFixture({
      status: "completed",
      updatedAt: completedAt,
      annotations: [
        annotationFixture({
          status: "completed",
          completedAt,
          extensions: { "demo.context": { ticket: "AF-2" } },
        }),
      ],
    });
    expect(
      formatAgentAnnotationsTaskMarkdown(single, { annotations: "all" })
    ).toMatchInlineSnapshot(`
      "# Agent Annotations Task task-1

      - schema: agent-annotations.task.v1
      - schemaVersion: 1
      - revision: 0
      - status: completed
      - createdAt: 2026-08-12T12:00:00.000Z
      - updatedAt: 2026-08-12T12:02:00.000Z

      ## Annotations (1)

      ### Annotation 1: [element] ann-1

      Comment: Make this clearer

      - status: completed @ 2026-08-12T12:02:00.000Z
      - page: /settings (Settings)

      #### Target

      - selector: main > button
      - bounds: 10,20 120x32
      - element: <button>
      - component: SaveButton
      - source: src/pages/settings.tsx:12:4 (SaveButton)
      - source stack:
        - src/pages/settings.tsx:12:4 (SaveButton)

      #### Extension context

      - demo.context: {\"ticket\":\"AF-2\"}
      "
    `);
  });

  it("supports the JSON public formatter", () => {
    expect(JSON.parse(formatAgentAnnotationsTask(task, { format: "json" }))).toEqual(task);
  });
});
