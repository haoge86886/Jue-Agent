import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureString } from "../path-utils.js";

export const httpRequestToolSpec: ToolSpec = {
  name: "http.request",
  displayName: "网络请求",
  description: "执行 HTTP/HTTPS 请求。默认用于读取公开 API；外部访问需要确认。",
  version: "0.1.0",
  kind: "builtin",
  category: "http",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, default: 30000 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url", "status", "headers", "body", "truncated"],
    properties: {
      url: { type: "string" },
      status: { type: "integer" },
      headers: { type: "object" },
      body: { type: "string" },
      truncated: { type: "boolean" },
    },
  },
  sideEffectLevel: "external",
  timeoutMs: 30_000,
  retryPolicy: { maxRetries: 1, backoffMs: 500, backoffStrategy: "fixed", retryOn: ["HTTP_REQUEST_FAILED", "TOOL_TIMEOUT"] },
  permissionScope: "user",
  confirmation: { required: true, reason: "该工具会访问外部网络", autoApproveScopes: [] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "http", "network"],
  sensitivity: "internal",
};

export interface HttpRequestHandlerOptions {
  allowedHosts?: string[];
  blockedHosts?: string[];
  maxBodyChars?: number;
}

export function createHttpRequestHandler(options: HttpRequestHandlerOptions = {}): ToolHandler {
  const maxBodyChars = options.maxBodyChars ?? 64_000;
  return async (args, ctx): Promise<ToolHandlerResult> => {
    const urlText = ensureString(args.url, "url");
    const url = new URL(urlText);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ToolExecutionError({ code: "HTTP_PROTOCOL_DENIED", message: `不支持的协议: ${url.protocol}`, nextStep: "仅使用 http 或 https URL。" });
    }
    checkHost(url.hostname, options.allowedHosts ?? [], options.blockedHosts ?? []);
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    const headers = normalizeHeaders(args.headers);
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const requestInit: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (typeof args.body === "string") requestInit.body = args.body;
      const response = await fetch(url, requestInit);
      const bodyText = await response.text();
      const truncated = bodyText.length > maxBodyChars;
      const output = {
        url: url.toString(),
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: truncated ? bodyText.slice(0, maxBodyChars) : bodyText,
        truncated,
      };
      return {
        output,
        summary: `HTTP ${method} ${url.hostname} -> ${response.status}${truncated ? "(截断)" : ""}`,
        tokenEstimate: Math.ceil(output.body.length / 4),
        truncated,
        ...(response.ok ? {} : { failure: { code: "HTTP_STATUS_ERROR", message: `HTTP 状态码 ${response.status}`, retriable: response.status >= 500 } }),
      };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ToolExecutionError({ code: "HTTP_TIMEOUT", message: `HTTP 请求超过 ${timeoutMs}ms`, retriable: true, nextStep: "缩小请求范围或稍后重试。" });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

function checkHost(host: string, allowedHosts: string[], blockedHosts: string[]): void {
  if (blockedHosts.includes(host)) {
    throw new ToolExecutionError({ code: "HTTP_HOST_BLOCKED", message: `主机被阻止: ${host}`, nextStep: "换用允许的主机或请求用户调整配置。" });
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    throw new ToolExecutionError({ code: "HTTP_HOST_NOT_ALLOWED", message: `主机不在白名单: ${host}`, nextStep: "使用白名单主机或请求用户调整配置。" });
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolExecutionError({ code: "INVALID_ARGUMENT", message: "headers 必须是对象", nextStep: "传入字符串键值对。" });
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, String(val)]));
}
