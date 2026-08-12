#!/usr/bin/env node

const help = `Agent Feedback 0.1.0-alpha.0

Usage: agent-feedback [--help]

Developer-only visual annotations and Code Agent feedback for React/Vite applications.
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(help);
} else {
  process.stderr.write(help);
  process.exitCode = 1;
}
