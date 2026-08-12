import type {
  AgentFeedbackAnnotation,
  AgentFeedbackTarget,
  AgentFeedbackTask,
} from "../../src/types/index.js";

export const targetFixture = (
  overrides: Partial<AgentFeedbackTarget> = {}
): AgentFeedbackTarget => ({
  selector: "main > button",
  bounds: { x: 10, y: 20, width: 120, height: 32 },
  inspection: {
    tagName: "button",
    role: "button",
    accessibleName: "Save",
    text: "Save",
    componentName: "SaveButton",
    source: {
      filePath: "src/pages/settings.tsx",
      lineNumber: 12,
      columnNumber: 4,
      componentName: "SaveButton",
    },
    sourceStack: [
      {
        filePath: "src/pages/settings.tsx",
        lineNumber: 12,
        columnNumber: 4,
        componentName: "SaveButton",
      },
    ],
    htmlPreview: "<button>Save</button>",
    styleText: "color: blue;",
    attributes: { "aria-label": "Save" },
  },
  ...overrides,
});

export const annotationFixture = (
  overrides: Partial<AgentFeedbackAnnotation> = {}
): AgentFeedbackAnnotation => ({
  annotationId: "ann-1",
  kind: "element",
  comment: "Make this clearer",
  status: "open",
  createdAt: "2026-08-12T12:00:00.000Z",
  pageContext: {
    url: "http://127.0.0.1:4173/settings",
    routeKey: "/settings",
    title: "Settings",
    viewport: { width: 1440, height: 900 },
    scroll: { x: 0, y: 0 },
  },
  targets: [targetFixture()],
  extensions: {},
  ...overrides,
});

export const taskFixture = (
  overrides: Partial<AgentFeedbackTask> = {}
): AgentFeedbackTask => ({
  schema: "agent-feedback.task.v1",
  schemaVersion: 1,
  taskId: "task-1",
  taskRevision: 0,
  status: "active",
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
  annotations: [annotationFixture()],
  ...overrides,
});
