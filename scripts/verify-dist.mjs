import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const missing = [];
const requireEntry = (file) => {
  if (typeof file !== "string" || !file.startsWith("./dist/")) return;
  if (!existsSync(path.join(root, file))) missing.push(file);
};

for (const conditions of Object.values(manifest.exports ?? {})) {
  if (typeof conditions === "string") requireEntry(conditions);
  else for (const value of Object.values(conditions)) requireEntry(value);
}
for (const file of Object.values(manifest.bin ?? {})) requireEntry(file);

if (missing.length) {
  console.error(`[agent-annotations] missing required dist entries: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("[agent-annotations] dist entries verified");
