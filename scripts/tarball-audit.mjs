import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const directory = mkdtempSync(path.join(tmpdir(), "agent-feedback-pack-audit-"));
try {
  const packed = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--pack-destination", directory], {
    cwd: root,
    encoding: "utf8",
  }));
  const files = packed.files.map(({ path: file }) => file).sort();
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const file of manifest.files) {
    if (!files.some((packedFile) => packedFile === file || packedFile.startsWith(`${file}/`))) {
      throw new Error(`files whitelist entry missing from tarball: ${file}`);
    }
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
  const size = statSync(packed.filename).size;
  if (size > 200_000) throw new Error(`tarball exceeds 200000-byte gate: ${size}`);
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error("workspace protocol in package metadata");
  console.log(`[agent-feedback] tarball audit PASS (${files.length} files, ${size} bytes)`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
