import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const exactTarball = process.argv[2] ? path.resolve(process.argv[2]) : null;
const expectedSha256 = process.argv[3];
const directory = exactTarball ? null : mkdtempSync(path.join(tmpdir(), "agent-annotations-pack-audit-"));
try {
  if (directory) execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd: root, encoding: "utf8" });
  const packedName = directory && readdirSync(directory).find((file) => file.endsWith(".tgz"));
  const tarball = exactTarball ?? (packedName ? path.join(directory, packedName) : null);
  if (!tarball) throw new Error("pnpm pack did not produce a tarball");
  const actualSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error("release candidate SHA-256 mismatch");
  const files = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
    .split("\n").map((file) => file.trim().replace(/^package\//, "")).filter(Boolean).sort();
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const file of manifest.files) {
    if (!files.some((packedFile) => packedFile === file || packedFile.startsWith(`${file}/`))) {
      throw new Error(`files whitelist entry missing from tarball: ${file}`);
    }
  }
  const requirePacked = (file) => {
    if (typeof file !== "string" || !file.startsWith("./dist/")) return;
    const packedFile = file.replace(/^\.\//, "");
    if (!files.includes(packedFile)) throw new Error(`exported entry missing from tarball: ${packedFile}`);
  };
  for (const conditions of Object.values(manifest.exports ?? {})) {
    if (typeof conditions === "string") requirePacked(conditions);
    else for (const value of Object.values(conditions)) requirePacked(value);
  }
  for (const file of Object.values(manifest.bin ?? {})) requirePacked(file);
  if (files.some((file) => file.startsWith("dist/audit/"))) {
    throw new Error("internal architecture audit artifact must not be shipped");
  }
  const allowed = /^(?:package\.json|LICENSE|README\.md|API\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md|dist\/)/;
  const unexpected = files.filter((file) => !allowed.test(file));
  if (unexpected.length) throw new Error(`unexpected tarball files: ${unexpected.join(", ")}`);
  const leaks = files.filter((file) => file.endsWith(".map") || /^(?:src|tests|fixtures|playgrounds|scripts)\//.test(file));
  if (leaks.length) throw new Error(`source or fixture files in tarball: ${leaks.join(", ")}`);
  const declarations = readdirSync(path.join(root, "dist"), { recursive: true })
    .filter((file) => typeof file === "string" && /\.d\.(?:ts|mts)$/.test(file));
  const internalPath = /\/root\/work|from\s+["'][^"']*src\/|import\s*\(["'][^"']*src\//;
  for (const file of declarations) {
    if (internalPath.test(readFileSync(path.join(root, "dist", file), "utf8"))) {
      throw new Error(`internal import path in declaration: dist/${file}`);
    }
  }
  const size = statSync(tarball).size;
  if (size > 200_000) throw new Error(`tarball exceeds 200000-byte gate: ${size}`);
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error("workspace protocol in package metadata");
  console.log(`[agent-annotations] tarball audit PASS (${files.length} files, ${size} bytes, sha256 ${actualSha256})`);
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
