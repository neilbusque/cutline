import { CUTLINE_VERSION } from "../shared/version";
import { cutlineCore } from "../shared/assistant-instructions";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** Larger text results are refused with advice; assistants cap tool output near 25,000 tokens. */
export const RESULT_LIMIT = 100_000;

export function mcpResult(value: any) {
  if (
    value?.content &&
    Array.isArray(value.content) &&
    value?.structuredContent
  )
    return value;
  const text = JSON.stringify(value ?? null);
  if (text.length > RESULT_LIMIT)
    return {
      content: [
        {
          type: "text" as const,
          text: `Cutline finished this call, but its result is too large to return (${text.length} characters). Ask for less: use clipIds, kinds, fromFrame and toFrame, offset or a smaller limit.`,
        },
      ],
    };
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function createMcpServer(
  list: () => Promise<Tool[]>,
  /** signal aborts when the request closes, as when the assistant is stopped. */
  call: (name: string, args: any, signal?: AbortSignal) => Promise<unknown>,
  instructions: string = cutlineCore,
) {
  const server = new Server(
    { name: "cutline", version: CUTLINE_VERSION },
    { capabilities: { tools: {} }, instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await list(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const tools = await list();
      if (!tools.some((tool) => tool.name === request.params.name))
        throw Error("Unknown Cutline tool");
      return mcpResult(
        await call(
          request.params.name,
          request.params.arguments ?? {},
          extra.signal,
        ),
      );
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Cutline: ${(error as Error).message}` },
        ],
      };
    }
  });
  return server;
}
