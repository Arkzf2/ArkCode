import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";
import { z } from "zod";
import type { Tool } from "@earendil-works/pi-mcp";

const rpcSchema = z.object({ method: z.string(), id: z.union([z.number(), z.string()]).optional(), params: z.unknown().optional() });
const callSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) });
export const echoMcpTool: Tool = { name: "echo", description: "Echo a message through MCP.", inputSchema: {
  type: "object", properties: { text: { type: "string" } }, required: ["text"],
}, annotations: { readOnlyHint: true } };

export async function httpMcpFixture(t: TestContext, options: {
  tools?: Tool[];
  call?: (call: z.infer<typeof callSchema>) => unknown | Promise<unknown>;
  authorization?: string;
  initialize?: () => Promise<void>;
} = {}) {
  let tools = options.tools ?? [echoMcpTool];
  const calls: Array<z.infer<typeof callSchema>> = [];
  const notifications: string[] = [];
  const sessions = new Set<string>();
  const streams = new Set<ServerResponse>();
  let initialized = 0;
  let closed = 0;
  let listed = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (options.authorization && request.headers.authorization !== options.authorization) { response.writeHead(401).end(); return; }
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": connected\n\n");
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      if (request.method === "DELETE") {
        const id = request.headers["mcp-session-id"];
        if (typeof id === "string" && sessions.delete(id)) closed++;
        response.writeHead(204).end(); return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const message = rpcSchema.parse(JSON.parse(body));
      if (message.id === undefined) { notifications.push(message.method); response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") {
        initialized++;
        await options.initialize?.();
        const id = randomUUID(); sessions.add(id);
        response.setHeader("mcp-session-id", id);
        result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } };
      } else if (message.method === "tools/list") { listed++; result = { tools }; }
      else if (message.method === "tools/call") {
        const call = callSchema.parse(message.params); calls.push(call);
        result = options.call ? await options.call(call) : { content: [{ type: "text", text: `MCP echo: ${String(call.arguments.text)}` }] };
      } else result = {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP MCP fixture did not listen.");
  t.after(async () => {
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, calls, notifications,
    get initialized() { return initialized; }, get closed() { return closed; }, get listed() { return listed; }, get streams() { return streams.size; },
    setTools(next: Tool[]) {
      tools = next;
      for (const stream of streams) stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
    },
  };
}
