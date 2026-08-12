export type AgentFeedbackJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentFeedbackJsonValue[]
  | { [key: string]: AgentFeedbackJsonValue };
