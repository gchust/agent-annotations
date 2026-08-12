import { agentFeedbackVersion } from "@gchust/agent-feedback";
import React from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <main>Agent Feedback {agentFeedbackVersion}</main>,
);
