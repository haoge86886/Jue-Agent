import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JsonSchemaLike, ToolSpec } from "@jue/shared-types";
import { estimateTokens } from "@jue/utils";
import { sanitizeToolName, type AdaptedTool, type ToolAdapterDiagnostic, type ToolAdapterResult } from "./tool-adapter.js";
import type { ToolHandler, ToolHandlerResult } from "./tool-executor.js";

export interface McpServerDefinition {
  id: string;
  displayName?: string;
  transport: "stdio" | "sse" | "websocket" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  toolPrefix?: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

type McpClient = Client;

/**
 * MCP 适配器。负责连接官方 SDK client、名称清洗、schema 补齐、结果标准化、
 * 注册失败诊断。外部 MCP 工具永远不能绕过这里直接进 ToolRegistry。
 */
export class MCPAdapter {
  async connectAndAdapt(server: McpServerDefinition): Promise<ToolAdapterResult> {
    const diagnostics: ToolAdapterDiagnostic[] = [];
    try {
      const client = new Client({ name: "jue-agent", version: "0.1.0" }, { capabilities: {} });
      await client.connect(createTransport(server));
      return await this.adaptClient(server, client, diagnostics);
    } catch (err) {
      diagnostics.push({
        serverId: server.id,
        severity: "error",
        code: "MCP_CONNECT_FAILED",
        message: err instanceof Error ? err.message : String(err),
        nextStep: "检查 MCP server 的 command/url/env 配置，并确认服务能独立启动。",
      });
      return { tools: [], diagnostics };
    }
  }

  async adaptClient(server: McpServerDefinition, client: McpClient, diagnostics: ToolAdapterDiagnostic[] = []): Promise<ToolAdapterResult> {
    const tools: AdaptedTool[] = [];
    const listed = await client.listTools().catch((err: unknown) => {
      diagnostics.push({
        serverId: server.id,
        severity: "error",
        code: "MCP_LIST_TOOLS_FAILED",
        message: err instanceof Error ? err.message : String(err),
        nextStep: "确认该 MCP server 支持 tools/list，并检查启动日志。",
      });
      return undefined;
    });
    if (!listed) return { tools, diagnostics };
    for (const tool of listed.tools) {
      if (server.allowedTools?.length && !server.allowedTools.includes(tool.name)) continue;
      if (server.blockedTools?.includes(tool.name)) continue;
      const name = sanitizeToolName(tool.name, server.toolPrefix ?? `mcp_${server.id}`);
      const inputSchema = normalizeSchema(tool.inputSchema);
      const outputSchema = normalizeSchema(tool.outputSchema ?? { type: "object", additionalProperties: true });
      const sideEffectLevel = tool.annotations?.destructiveHint ? "destructive" : tool.annotations?.readOnlyHint ? "none" : "external";
      const spec: ToolSpec = {
        name,
        displayName: tool.title ?? tool.name,
        description: tool.description ?? `MCP 工具 ${tool.name}`,
        version: "0.1.0",
        kind: "mcp",
        category: "other",
        inputSchema,
        outputSchema,
        sideEffectLevel,
        timeoutMs: 30_000,
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
        permissionScope: "user",
        confirmation: { required: sideEffectLevel !== "none", reason: "外部 MCP 工具可能访问外部系统", autoApproveScopes: [] },
        availabilityCheck: { kind: "probe", envKeys: [], probeId: server.id },
        errorMapping: [],
        tags: ["mcp", server.id, tool.name],
        sensitivity: "internal",
        metadata: { mcpServerId: server.id, mcpOriginalName: tool.name },
      };
      tools.push({ spec, handler: createMcpToolHandler(client, tool.name), enabled: true });
    }
    return { tools, diagnostics };
  }
}

function createMcpToolHandler(client: McpClient, originalName: string): ToolHandler {
  return async (args): Promise<ToolHandlerResult> => {
    const result = await client.callTool({ name: originalName, arguments: args });
    const normalized = normalizeMcpResult(result);
    return {
      output: normalized.output,
      summary: normalized.summary,
      tokenEstimate: estimateTokens(normalized.summary),
      ...(normalized.isError ? { failure: { code: "MCP_TOOL_ERROR", message: normalized.summary, retriable: false } } : {}),
    };
  };
}

function normalizeMcpResult(result: unknown): { output: unknown; summary: string; isError: boolean } {
  if (isObject(result) && "toolResult" in result) {
    const output = (result as { toolResult: unknown }).toolResult;
    return { output, summary: summarizeUnknown(output), isError: false };
  }
  if (isObject(result)) {
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    const content = Array.isArray((result as { content?: unknown }).content) ? (result as { content: unknown[] }).content : [];
    const text = content.map((item) => isObject(item) && typeof item.text === "string" ? item.text : JSON.stringify(item)).join("\n");
    const output = structured ?? { content };
    return { output, summary: text || summarizeUnknown(output), isError: Boolean((result as { isError?: unknown }).isError) };
  }
  return { output: result, summary: summarizeUnknown(result), isError: false };
}

function normalizeSchema(schema: unknown): JsonSchemaLike {
  if (schema === true || schema === false) return schema;
  if (!isObject(schema)) return { type: "object", additionalProperties: true };
  if (!schema.type) return { ...schema, type: "object" } as JsonSchemaLike;
  return schema as JsonSchemaLike;
}

function createTransport(server: McpServerDefinition) {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("stdio MCP server 缺少 command");
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      stderr: "pipe",
    }) as Transport;
  }
  if (!server.url) throw new Error(`${server.transport} MCP server 缺少 url`);
  const url = new URL(server.url);
  const requestInit: RequestInit = {};
  if (server.headers) requestInit.headers = server.headers;
  if (server.transport === "sse") return new SSEClientTransport(url, { requestInit }) as Transport;
  if (server.transport === "websocket") return new WebSocketClientTransport(url) as Transport;
  return new StreamableHTTPClientTransport(url, { requestInit }) as Transport;
}

function summarizeUnknown(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
