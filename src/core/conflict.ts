import type { AgentAnnotationsTask } from "../types/index.js";

export class RevisionConflictError extends Error {
  readonly code = "revision_conflict" as const;
  readonly latestTask: AgentAnnotationsTask;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(
    latestTask: AgentAnnotationsTask,
    expectedRevision: number,
    actualRevision: number
  ) {
    super(`revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "RevisionConflictError";
    this.latestTask = latestTask;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}
