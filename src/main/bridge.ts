import { CUTLINE_VERSION } from "../shared/version";
import http from "node:http";
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Store } from "./store";
import { createMcpServer } from "./mcp-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
export async function startBridge(
  store: Store,
  connectionFile: string | null,
  /** signal aborts when the caller goes away before the answer. */
  call: (name: string, args: any, signal?: AbortSignal) => Promise<unknown>,
  toolList: any[],
  options: {
    localCall?: (
      name: string,
      args: any,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    localTools?: any[];
  } = {},
) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] !== token) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      if (parts[1] === "mcp") {
        if (
          req.headers.origin &&
          req.headers.origin !== "null" &&
          !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
            req.headers.origin,
          )
        ) {
          res.writeHead(403);
          res.end("Use a local MCP client or Secure MCP Tunnel.");
          return;
        }
        const local = parts[2] === "local" && options.localCall;
        // The built-in assistants get the full workflow as their system
        // prompt, so their server sends no instructions of its own.
        const protocol = createMcpServer(
          async () =>
            (local ? (options.localTools ?? toolList) : toolList) as Tool[],
          local ? options.localCall! : call,
          ...(local ? [""] : []),
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void protocol.close();
        });
        await protocol.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
      }
      if (parts[1] === "media" && req.method === "GET") {
        const asset = store.project.assets.find((a) => a.id === parts[2]);
        const file =
          parts[3] === "thumb"
            ? asset?.thumbnail
            : parts[3] === "proxy"
              ? asset?.proxy
              : parts[3] === "reversed"
                ? asset?.reversed
                : asset?.path;
        if (!file || !existsSync(file)) {
          res.writeHead(404);
          res.end("Media is missing. Relink the source.");
          return;
        }
        const size = statSync(file).size;
        const ext = path.extname(file).toLowerCase();
        const mime: Record<string, string> = {
          ".mp4": "video/mp4",
          ".mov": "video/quicktime",
          ".webm": "video/webm",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".m4a": "audio/mp4",
          ".aac": "audio/aac",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".gif": "image/gif",
        };
        res.setHeader("Content-Type", mime[ext] ?? "application/octet-stream");
        res.setHeader("Accept-Ranges", "bytes");
        let start = 0,
          end = size - 1;
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        res.setHeader("Content-Length", end - start + 1);
        const stream = createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (parts[1] === "rpc" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 2_000_000) throw Error("Request too large");
        }
        const { name, args } = JSON.parse(body);
        // A caller that goes away before the answer stops its work.
        const gone = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) gone.abort();
        });
        const value =
          name === "tools.list"
            ? toolList
            : await call(name, args ?? {}, gone.signal);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ result: value }));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as any;
  const base = `http://127.0.0.1:${address.port}/${token}`;
  if (connectionFile)
    writeFileSync(
      connectionFile,
      JSON.stringify({
        base,
        mcpUrl: `${base}/mcp`,
        pid: process.pid,
        version: CUTLINE_VERSION,
        protocols: ["stdio", "streamable-http"],
      }),
      {
        mode: 0o600,
      },
    );
  return {
    base,
    mcpUrl: `${base}/mcp`,
    close: () => {
      server.close();
      // A closed app leaves no connection behind, so launchers report that
      // Cutline is closed instead of failing against a dead port. A newer
      // instance's file is left alone.
      if (!connectionFile) return;
      try {
        if (JSON.parse(readFileSync(connectionFile, "utf8")).base === base)
          unlinkSync(connectionFile);
      } catch {
        /* Already gone or unreadable. */
      }
    },
  };
}
