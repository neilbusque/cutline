// Test-only preload inherited by Kokoro's child process and inference worker.
// Permit the editor's local bridge, but fail any external network attempt.
const { appendFileSync } = require("node:fs");
const { threadId } = require("node:worker_threads");
const log = (event) => {
  appendFileSync(
    process.env.CUTLINE_OFFLINE_LOG,
    JSON.stringify({ pid: process.pid, threadId, ...event }) + "\n",
  );
};
const local = (host) =>
  !host || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
const check = (host) => {
  if (local(host)) return;
  log({ blocked: host });
  throw Error(`Offline QA blocked external network access: ${host}`);
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  check(
    new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    ).hostname,
  );
  return fetch(input, options);
};
const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === "object")
    check(options.host || options.hostname);
  else if (typeof options === "number" && typeof args[1] === "string")
    check(args[1]);
  return connect.apply(this, args);
};
const dns = require("node:dns");
for (const method of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const original = dns[method];
  dns[method] = function (host, ...args) {
    check(host);
    return original.call(this, host, ...args);
  };
}
log({ loaded: true });
// Negative control: the hook must reject this before invoking real fetch.
try {
  globalThis.fetch("https://cutline-offline-check.invalid/");
  throw Error("Offline QA guard did not reject its control request.");
} catch (error) {
  if (!error.message.startsWith("Offline QA blocked external network access:"))
    throw error;
  log({ verified: true });
}
