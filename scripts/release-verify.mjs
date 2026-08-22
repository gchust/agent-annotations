import { installBrowserConsumer, prepareCandidate, runVerificationSteps } from "./release-candidate.mjs";

try {
  const candidate = prepareCandidate();
  installBrowserConsumer(candidate);
  runVerificationSteps(candidate);
  console.log(`[agent-annotations] release verification PASS: ${candidate.sha256}`);
} catch (error) {
  console.error(`[agent-annotations] release candidate preserved after failure`);
  throw error;
}
