import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent } from "undici";
import type { McpServerDef } from "./loader.js";
import type { ToolDefinition } from "../types.js";
import { safeChildEnv } from "../secrets/safe-env.js";
import { log } from "../log.js";

// MCP HTTP/SSE transports must bypass the global undici dispatcher. When OneCLI
// installs its MITM ProxyAgent via setGlobalDispatcher, routing the MCP streaming
// transport through it corrupts the response — undici throws
// "Response does not match the HTTP/1.1 protocol (Expected HTTP/, RTSP/ or ICE/)".
// MCP servers are local and/or authenticate with their own explicit headers; they
// never need OneCLI's per-request credential injection (unlike the LLM call). So
// give them a direct dispatcher. A custom `fetch` is the reliable injection point —
// the SDK routes every request (POST, GET stream, reconnect) through `opts.fetch`.
const mcpDirectDispatcher = new Agent();
const mcpDirectFetch = ((input: unknown, init?: unknown) =>
  fetch(input as Parameters<typeof fetch>[0], {
    ...((init as Record<string, unknown>) ?? {}),
    dispatcher: mcpDirectDispatcher,
  } as unknown as RequestInit)) as typeof fetch;

export interface ConnectedServer {
  name: string;
  client: Client;
  tools: ToolDefinition[];
  close(): Promise<void>;
}


export async function connectMcpServer(name: string, def: McpServerDef): Promise<ConnectedServer> {
  const client = new Client({ name: "daedalus", version: "0.1.0" }, { capabilities: {} });

  const transport = (await buildTransport(def)) as Transport;
  await client.connect(transport);

  const tools: ToolDefinition[] = [];
  try {
    const list = await client.listTools();
    for (const t of list.tools) {
      tools.push({
        name: `${name}__${t.name}`,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      });
    }
  } catch (err) {
    log.warn({ name, err }, "MCP server has no listTools or it failed");
  }

  return {
    name,
    client,
    tools,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

async function buildTransport(def: McpServerDef) {
  const transportKind = def.transport ?? (def.url ? "http" : "stdio");
  switch (transportKind) {
    case "stdio": {
      if (!def.command) throw new Error("stdio MCP server requires 'command'");
      return new StdioClientTransport({
        command: def.command,
        args: def.args,
        // SEC-07: a stdio MCP server is a child process — don't hand it the supervisor's
        // entire environment (every API key/token). Pass only operational vars + OneCLI
        // proxy/CA plumbing, plus whatever the server explicitly declares. A server needing
        // a specific secret must declare it in its own `env:` (e.g. FOO: "${FOO}").
        env: { ...safeChildEnv(), ...def.env } as Record<string, string>,
        ...(def.cwd ? { cwd: def.cwd } : {}),
      });
    }
    case "http": {
      if (!def.url) throw new Error("http MCP server requires 'url'");
      const requestInit: RequestInit | undefined =
        Object.keys(def.headers).length > 0 ? { headers: def.headers } : undefined;
      return new StreamableHTTPClientTransport(new URL(def.url), {
        ...(requestInit ? { requestInit } : {}),
        fetch: mcpDirectFetch,
      });
    }
    case "sse": {
      if (!def.url) throw new Error("sse MCP server requires 'url'");
      const requestInit: RequestInit | undefined =
        Object.keys(def.headers).length > 0 ? { headers: def.headers } : undefined;
      return new SSEClientTransport(new URL(def.url), {
        ...(requestInit ? { requestInit } : {}),
        fetch: mcpDirectFetch,
      });
    }
  }
}

// Invoke a tool whose name is namespaced as "<server>__<tool>". Returns string content.
export async function callMcpTool(
  servers: Map<string, ConnectedServer>,
  namespacedName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const sep = namespacedName.indexOf("__");
  if (sep === -1) {
    return { content: `unknown tool: ${namespacedName}`, isError: true };
  }
  const serverName = namespacedName.slice(0, sep);
  const toolName = namespacedName.slice(sep + 2);
  const server = servers.get(serverName);
  if (!server) return { content: `unknown MCP server: ${serverName}`, isError: true };

  const res = (await server.client.callTool({ name: toolName, arguments: input })) as {
    content?: Array<{ type: string; text?: string; mimeType?: string }>;
    isError?: boolean;
  };
  const content = (res.content ?? [])
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "image") return `[image ${c.mimeType ?? "image/*"}]`;
      return JSON.stringify(c);
    })
    .join("\n");
  return { content, isError: Boolean(res.isError) };
}
