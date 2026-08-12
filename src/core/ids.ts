export function createAgentFeedbackId(): string {
  return globalThis.crypto.randomUUID();
}
