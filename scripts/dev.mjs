import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createServer } from "vite";
import {
  assertSupportedPlatform,
  developmentEnvironment,
  mainEntryPoints,
  prepareMediaBinaries,
} from "./setup-support.mjs";

assertSupportedPlatform();
await prepareMediaBinaries();
await build({
  entryPoints: mainEntryPoints,
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  packages: "external",
});
let server, electron, stopTimer;
let stopping = false;
const stop = () => {
  stopping = true;
  if (electron && electron.exitCode === null && !electron.killed) {
    electron.kill("SIGTERM");
    stopTimer = setTimeout(
      () => electron.exitCode === null && electron.kill("SIGKILL"),
      5000,
    );
    stopTimer.unref();
  }
};
const interrupted = () => {
  process.exitCode = 130;
  stop();
};
const terminated = () => {
  process.exitCode = 143;
  stop();
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", terminated);
try {
  server = await createServer();
  await server.listen();
  if (!stopping) {
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw Error("Vite did not expose a local development port.");
    const require = createRequire(import.meta.url);
    const executable = require("electron");
    electron = spawn(executable, ["."], {
      stdio: "inherit",
      env: developmentEnvironment(
        process.env,
        `http://127.0.0.1:${address.port}`,
      ),
    });
    const code = await new Promise((resolve, reject) => {
      electron.once("error", reject);
      electron.once("exit", (code, signal) =>
        resolve(code ?? (signal ? 1 : 0)),
      );
    });
    if (!stopping) process.exitCode = code;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stop();
  clearTimeout(stopTimer);
  await server?.close();
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", terminated);
}
