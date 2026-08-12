# Agent Feedback

Developer-only visual annotations and Code Agent feedback for React/Vite applications.

The package root exports the host-neutral `agent-feedback.task.v1` core and
`mountAgentFeedback()` browser runtime. Public contracts are also available
from `@gchust/agent-feedback/types`; `MemoryTaskTransport` is available only
from `@gchust/agent-feedback/testing` for tests and playgrounds.

Vite persistence and CLI commands beyond `--help` are not yet implemented.
