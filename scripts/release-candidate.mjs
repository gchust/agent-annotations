import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
export const candidateRoot = path.join(root, "artifacts/release-candidate");
export const tarball = path.join(
  candidateRoot,
  `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`
);
export const browserConsumer = path.join(candidateRoot, "browser-consumer");
export const metadataPath = path.join(candidateRoot, "metadata.json");

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function candidateEnvironment(candidate) {
  return {
    AGENT_ANNOTATIONS_CANDIDATE_TARBALL: candidate.tarball,
    AGENT_ANNOTATIONS_CANDIDATE_SHA256: candidate.sha256,
    AGENT_ANNOTATIONS_CANDIDATE_CONSUMER: candidate.browserConsumer,
  };
}

export function verificationSteps(candidate) {
  const env = candidateEnvironment(candidate);
  return [
    { name: "typecheck", command: "pnpm", args: ["typecheck"], env },
    { name: "tests", command: "pnpm", args: ["test:release"], env },
    { name: "architecture", command: "pnpm", args: ["check:architecture"], env },
    { name: "docs", command: "pnpm", args: ["check:docs"], env },
    { name: "publint", command: "pnpm", args: ["exec", "publint", candidate.tarball], env },
    { name: "attw", command: "pnpm", args: ["exec", "attw", candidate.tarball, "--profile", "esm-only"], env },
    { name: "tarball", command: process.execPath, args: [path.join(root, "scripts/tarball-audit.mjs"), candidate.tarball, candidate.sha256], env },
    { name: "core-consumer", command: process.execPath, args: [path.join(root, "scripts/node20-smoke.mjs"), candidate.tarball, candidate.sha256, path.join(candidateRoot, "core-consumer")], env },
    { name: "browser-consumer", command: process.execPath, args: [path.join(root, "scripts/packed-e2e.mjs")], env },
  ];
}

export function runVerificationSteps(candidate, run = spawnSync, logs = candidateRoot) {
  for (const step of verificationSteps(candidate)) {
    const result = run(step.command, step.args, {
      cwd: root,
      env: { ...process.env, ...step.env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(path.join(logs, `${step.name}.log`), output);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${step.name} failed with exit ${result.status ?? result.signal ?? "unknown"}`);
  }
}

function runCandidateCommand(name, args) {
  const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(candidateRoot, `${name}.log`), output);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit ${result.status ?? result.signal ?? "unknown"}`);
}

export function loadCandidate() {
  if (!existsSync(metadataPath)) throw new Error("run pnpm release:verify before the repeat gate");
  const candidate = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!existsSync(candidate.tarball) || sha256File(candidate.tarball) !== candidate.sha256) {
    throw new Error("preserved release candidate is missing or its SHA-256 changed");
  }
  if (!existsSync(path.join(candidate.browserConsumer, "node_modules"))) {
    throw new Error("preserved release browser consumer is not installed");
  }
  const consumerTarball = path.join(candidate.browserConsumer, "gchust-agent-annotations.tgz");
  if (!existsSync(consumerTarball) || sha256File(consumerTarball) !== candidate.sha256) {
    throw new Error("installed release browser consumer does not retain the exact candidate tarball");
  }
  return candidate;
}

export function prepareCandidate() {
  rmSync(candidateRoot, { recursive: true, force: true });
  mkdirSync(candidateRoot, { recursive: true });
  for (const [name, args] of [
    ["build", ["build"]],
    ["pack", ["pack", "--config.ignore-scripts=true", "--json", "--out", tarball]],
  ]) {
    runCandidateCommand(name, args);
  }
  if (!existsSync(tarball)) throw new Error("pnpm pack did not create the release candidate tarball");
  const files = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
    .split("\n").map((file) => file.trim()).filter(Boolean).sort();
  const candidate = {
    tarball,
    sha256: sha256File(tarball),
    size: statSync(tarball).size,
    files,
    browserConsumer,
  };
  writeFileSync(metadataPath, `${JSON.stringify(candidate, null, 2)}\n`);
  writeFileSync(path.join(candidateRoot, "manifest.txt"), `${files.join("\n")}\n`);
  console.log(`[agent-annotations] release candidate ${candidate.tarball}`);
  console.log(`[agent-annotations] sha256 ${candidate.sha256} (${candidate.size} bytes, ${files.length} files)`);
  return candidate;
}

export function installBrowserConsumer(candidate) {
  const fixture = path.join(root, "fixtures/packed-react-vite");
  const generated = new Set(["node_modules", "dist", ".agent-annotations", "playwright-report", "test-results"]);
  cpSync(fixture, candidate.browserConsumer, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixture, source);
      return !relative.split(path.sep).some((part) => generated.has(part))
        && path.basename(source) !== "pnpm-lock.yaml"
        && !/[.](?:tgz|png|zip|log)$/.test(source);
    },
  });
  cpSync(candidate.tarball, path.join(candidate.browserConsumer, "gchust-agent-annotations.tgz"));
}
