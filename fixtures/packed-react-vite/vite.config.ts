import react from "@vitejs/plugin-react";
import agentFeedback from "@gchust/agent-feedback/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), agentFeedback()],
});
