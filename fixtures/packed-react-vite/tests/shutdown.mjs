import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtimeRoot = path.resolve(".agent-feedback");
const sessionPath = path.join(runtimeRoot, "session.json");
const vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

rmSync(sessionPath, { force: true });
const child = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await waitFor(() => existsSync(sessionPath), "Vite did not create session.json");
  const session = JSON.parse(readFileSync(sessionPath, "utf8"));
  if (session.pid !== child.pid) throw new Error("session.json does not belong to the direct Vite process");
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  await waitFor(() => !existsSync(sessionPath), "SIGTERM did not remove session.json");
  console.log("SIGTERM removed session.json");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
