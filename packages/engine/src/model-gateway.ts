/**
 * @file model-gateway.ts
 * @module @jue/engine/model-gateway
 *
 * 统一的 LLM 网关。把多种 provider 屏蔽到同一接口下,业务代码只面对此层。
 *
 * 当前阶段实现:OpenAI 兼容协议(支持 OpenAI / DeepSeek / Moonshot / Qwen 等
 * 兼容 OpenAI 格式的 provider,通过 baseURL 区分)。
 *
 * 后续会按 ModelProvider 派生不同的 Adapter:
 *   - AnthropicAdapter
 *   - AzureOpenAIAdapter
 *   - OllamaAdapter
 *   - …
 *
 * 流式协议:`invoke()` 返回 AsyncIterable<ModelChunk>,调用方按 chunk 增量消费。
 * 非流式调用方可以收集所有 chunks 拼成完整文本。
 */

import { OpenAI } from "openai";
import type { Stream } from "openai/streaming";
import type { ChatCompletion, ChatCompletionChunk } from "openai/resources/chat/completions";
import { getModuleLogger, newId } from "@jue/utils";
import type { ModelProfile } from "@jue/config";
import type { ChatMessage, ChatToolCall } from "@jue/context";

const MODEL_CONNECT_MAX_ATTEMPTS = 5;
const MODEL_CONNECT_TIMEOUT_MS = 12_000;
const MODEL_CONNECT_RETRY_DELAY_MS = 500;
const MODEL_CONNECT_CANCELLED_MESSAGE = "模型调用已取消。";

/**
 * OpenAI Function Calling 风格的工具描述。
 *
 * Engine 会从 ToolRegistry 里的 `ToolSpec` 转换出此结构,业务层不直接构造。
 */
export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema(`object` 顶层) */
    parameters: Record<string, unknown>;
  };
}

/**
 * 模型调用入参。
 */
export interface ModelInvokeParams {
  /** 完整对话消息序列(已含 system) */
  messages: ChatMessage[];
  /** 强制非流式可设 false。默认根据 profile.streamByDefault 决定 */
  stream?: boolean;
  /** 截断 finish 用,某些 provider 在 invoke 期间允许传 stop 序列 */
  stop?: string[];
  /** 可调用的工具集合(OpenAI Function Calling 协议) */
  tools?: ModelToolDefinition[];
  /**
   * 工具选择策略:
   *   - 不传:由模型自由决定
   *   - "auto" / "none":对应 OpenAI 同名语义
   *   - 显式对象:强制调用某个工具
   */
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  /** 透传给 provider 的额外参数(谨慎使用) */
  providerOptions?: Record<string, unknown>;
  /** 前端取消信号。Esc / stop 等操作会通过它中止模型请求。 */
  signal?: AbortSignal;
  onStatus?: (status: ModelStatusChunk) => void;
}

/**
 * 流式 chunk 形态。每次拿到一段新增 token,以及结束信号。
 *
 * - `delta`        : 本次新增的文本(增量)。`finish` 块时为空字符串
 * - `toolCalls`    : 仅 finish 块出现,表示模型本轮决定调用的工具列表(已聚合)
 * - `finishReason` : 结束原因(只在 `finish` 块上有值)
 * - `usage`        : 本次调用的 token 用量(可能直到最后一块才提供)
 */
export interface ModelChunk {
  type: "delta" | "finish" | "status";
  delta: string;
  status?: ModelStatusChunk;
  toolCalls?: ChatToolCall[];
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface ModelStatusChunk {
  phase: "connecting" | "retrying";
  attempt: number;
  maxAttempts: number;
  message: string;
  baseURL?: string;
  model?: string;
  error?: string;
}

/**
 * 模型网关接口。所有 provider adapter 都要满足。
 */
export interface ModelGateway {
  /**
   * 发起模型调用。返回 AsyncIterable,流式与非流式统一通过迭代消费。
   *
   * 调用方负责处理网络/超时错误。RetryPolicy 后续在 Engine 层包一层装饰即可。
   */
  invoke(params: ModelInvokeParams): AsyncIterable<ModelChunk>;
}

/**
 * OpenAI 兼容 adapter。
 *
 * 兼容矩阵:
 *   - OpenAI 官方
 *   - DeepSeek(`https://api.deepseek.com/v1`)
 *   - Moonshot(`https://api.moonshot.cn/v1`)
 *   - Qwen(`https://dashscope.aliyuncs.com/compatible-mode/v1`)
 *   - 自部署 OpenAI 兼容服务(vLLM / oneapi 等)
 *
 * 通过 ModelProfile.baseURL 切换。
 */
export class OpenAICompatibleGateway implements ModelGateway {
  private readonly logger = getModuleLogger("model-gateway");
  private readonly client: OpenAI;
  private readonly profile: ModelProfile;

  constructor(profile: ModelProfile) {
    this.profile = profile;
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: profile.apiKey ?? "EMPTY",
    };
    if (profile.baseURL) opts.baseURL = profile.baseURL;
    if (profile.organization) opts.organization = profile.organization;
    if (profile.timeoutMs) opts.timeout = profile.timeoutMs;
    this.client = new OpenAI(opts);
    this.logger.debug(
      { id: profile.id, model: profile.modelName, baseURL: profile.baseURL ?? "(default)" },
      "model gateway ready",
    );
  }

  async *invoke(params: ModelInvokeParams): AsyncIterable<ModelChunk> {
    const stream = params.stream ?? true;
    const sampling = this.profile.sampling;
    const limits = this.profile.limits;

    const reqBase = {
      model: this.profile.modelName,
      messages: params.messages.map((m) => buildOpenAIMessage(m)),
      ...(sampling
        ? {
            temperature: sampling.temperature,
            top_p: sampling.topP,
            presence_penalty: sampling.presencePenalty,
            frequency_penalty: sampling.frequencyPenalty,
          }
        : {}),
      ...(limits ? { max_tokens: limits.maxOutputTokens } : {}),
      ...(params.stop && params.stop.length > 0 ? { stop: params.stop } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.toolChoice !== undefined && params.tools && params.tools.length > 0 ? { tool_choice: params.toolChoice } : {}),
      ...(params.providerOptions ?? {}),
    } as unknown as Parameters<typeof this.client.chat.completions.create>[0];

    if (!stream) {
      const res = await this.createNonStreamCompletionWithRetry({
        ...reqBase,
        stream: false,
      }, params.signal ? { signal: params.signal } : undefined, params.onStatus);
      const choice = res.choices[0];
      const text = choice?.message?.content ?? "";
      const toolCalls = extractToolCallsFromMessage(choice?.message);
      if (text) yield { type: "delta", delta: text };
      yield {
        type: "finish",
        delta: "",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(choice?.finish_reason
          ? { finishReason: mapFinishReason(choice.finish_reason) }
          : {}),
        ...(res.usage
          ? {
              usage: {
                promptTokens: res.usage.prompt_tokens,
                completionTokens: res.usage.completion_tokens,
                totalTokens: res.usage.total_tokens,
              },
            }
          : {}),
      };
      return;
    }

    let it: Stream<ChatCompletionChunk> | undefined;
    for await (const item of this.createStreamCompletionWithRetryEvents({
      ...reqBase,
      stream: true,
      stream_options: { include_usage: true },
    }, params.signal ? { signal: params.signal } : undefined)) {
      if (isModelStatusChunk(item)) {
        yield { type: "status", delta: "", status: item };
      } else {
        it = item;
      }
    }
    if (!it) return;

    let lastFinish: ModelChunk["finishReason"];
    let lastUsage: ModelChunk["usage"];
    /** index → 累加中的 tool call。OpenAI 按 index 增量推 name/arguments */
    const toolCallBuf = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const event of it) {
      if (params.signal?.aborted) break;
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content ?? "";
      if (delta) {
        yield { type: "delta", delta };
      }
      const deltaToolCalls = (
        choice?.delta as { tool_calls?: OpenAIToolCallDelta[] } | undefined
      )?.tool_calls;
      if (deltaToolCalls) {
        for (const tc of deltaToolCalls) {
          accumulateToolCallDelta(toolCallBuf, tc);
        }
      }
      if (choice?.finish_reason) {
        lastFinish = mapFinishReason(choice.finish_reason);
      }
      const usageEvent = (event as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
      if (usageEvent) {
        lastUsage = {
          ...(usageEvent.prompt_tokens !== undefined ? { promptTokens: usageEvent.prompt_tokens } : {}),
          ...(usageEvent.completion_tokens !== undefined ? { completionTokens: usageEvent.completion_tokens } : {}),
          ...(usageEvent.total_tokens !== undefined ? { totalTokens: usageEvent.total_tokens } : {}),
        };
      }
    }

    const toolCalls: ChatToolCall[] = [...toolCallBuf.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id,
        type: "function",
        function: { name: v.name, arguments: v.arguments || "{}" },
      }));

    yield {
      type: "finish",
      delta: "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(lastFinish ? { finishReason: lastFinish } : {}),
      ...(lastUsage ? { usage: lastUsage } : {}),
    };
  }

  private async createNonStreamCompletionWithRetry(
    request: Parameters<typeof this.client.chat.completions.create>[0],
    options: Parameters<typeof this.client.chat.completions.create>[1] | undefined,
    onStatus: ModelInvokeParams["onStatus"],
  ): Promise<ChatCompletion> {
    return this.createCompletionWithRetry(request, options, onStatus) as Promise<ChatCompletion>;
  }

  private async createStreamCompletionWithRetry(
    request: Parameters<typeof this.client.chat.completions.create>[0],
    options: Parameters<typeof this.client.chat.completions.create>[1] | undefined,
    onStatus: ModelInvokeParams["onStatus"],
  ): Promise<Stream<ChatCompletionChunk>> {
    return this.createCompletionWithRetry(request, options, onStatus) as Promise<Stream<ChatCompletionChunk>>;
  }

  private async *createStreamCompletionWithRetryEvents(
    request: Parameters<typeof this.client.chat.completions.create>[0],
    options: Parameters<typeof this.client.chat.completions.create>[1] | undefined,
  ): AsyncIterable<Stream<ChatCompletionChunk> | ModelStatusChunk> {
    let lastError: unknown;
    const signal = options?.signal ?? undefined;
    if (signal?.aborted) throw new ModelGatewayConnectionError(MODEL_CONNECT_CANCELLED_MESSAGE, { cause: lastError });

    // 第一次请求作为静默预检：配置正常时只显示 thinking，不暴露 retry 噪音。
    try {
      const stream = await this.withConnectTimeout(
        this.client.chat.completions.create(request, options) as Promise<Stream<ChatCompletionChunk>>,
        signal,
      );
      yield stream;
      return;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (isNonRetriableRequestError(err)) throw createModelRequestError(this.profile, err, request);
      this.logConnectionFailure(0, err);
    }

    for (let attempt = 1; attempt <= MODEL_CONNECT_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new ModelGatewayConnectionError(MODEL_CONNECT_CANCELLED_MESSAGE, { cause: lastError });
      yield this.buildStatus("retrying", attempt, lastError);
      try {
        const stream = await this.withConnectTimeout(
          this.client.chat.completions.create(request, options) as Promise<Stream<ChatCompletionChunk>>,
          signal,
        );
        yield stream;
        return;
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        if (isNonRetriableRequestError(err)) throw createModelRequestError(this.profile, err, request);
        this.logConnectionFailure(attempt, err);
        if (attempt >= MODEL_CONNECT_MAX_ATTEMPTS) break;
        await sleep(MODEL_CONNECT_RETRY_DELAY_MS * attempt, signal);
      }
    }
    throw createModelConnectionError(this.profile, lastError, MODEL_CONNECT_MAX_ATTEMPTS);
  }

  private async createCompletionWithRetry(
    request: Parameters<typeof this.client.chat.completions.create>[0],
    options: Parameters<typeof this.client.chat.completions.create>[1] | undefined,
    onStatus: ModelInvokeParams["onStatus"],
  ): Promise<unknown> {
    let lastError: unknown;
    const signal = options?.signal ?? undefined;
    if (signal?.aborted) throw new ModelGatewayConnectionError(MODEL_CONNECT_CANCELLED_MESSAGE, { cause: lastError });

    // 非流式调用也先静默预检，保持所有前端的连接状态语义一致。
    try {
      return await this.withConnectTimeout(
        this.client.chat.completions.create(request, options),
        signal,
      );
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (isNonRetriableRequestError(err)) throw createModelRequestError(this.profile, err, request);
      this.logConnectionFailure(0, err);
    }

    for (let attempt = 1; attempt <= MODEL_CONNECT_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new ModelGatewayConnectionError(MODEL_CONNECT_CANCELLED_MESSAGE, { cause: lastError });
      onStatus?.(this.buildStatus("retrying", attempt, lastError));
      try {
        return await this.withConnectTimeout(
          this.client.chat.completions.create(request, options),
          signal,
        );
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        if (isNonRetriableRequestError(err)) throw createModelRequestError(this.profile, err, request);
        this.logConnectionFailure(attempt, err);
        if (attempt >= MODEL_CONNECT_MAX_ATTEMPTS) break;
        await sleep(MODEL_CONNECT_RETRY_DELAY_MS * attempt, signal);
      }
    }
    throw createModelConnectionError(this.profile, lastError, MODEL_CONNECT_MAX_ATTEMPTS);
  }

  private buildStatus(
    phase: ModelStatusChunk["phase"],
    attempt: number,
    err?: unknown,
  ): ModelStatusChunk {
    const baseURL = this.profile.baseURL ?? "OpenAI 默认地址";
    const error = err ? errorMessage(err) : undefined;
    return {
      phase,
      attempt,
      maxAttempts: MODEL_CONNECT_MAX_ATTEMPTS,
      message: error
        ? `模型连接失败，正在重试 ${attempt}/${MODEL_CONNECT_MAX_ATTEMPTS}...`
        : `正在连接模型服务 ${attempt}/${MODEL_CONNECT_MAX_ATTEMPTS}...`,
      baseURL,
      model: this.profile.modelName,
      ...(error ? { error } : {}),
    };
  }

  private logConnectionFailure(attempt: number, err: unknown): void {
    this.logger.warn(
      {
        attempt,
        maxAttempts: MODEL_CONNECT_MAX_ATTEMPTS,
        baseURL: this.profile.baseURL ?? "(default)",
        model: this.profile.modelName,
        error: errorMessage(err),
      },
      attempt === 0 ? "model gateway silent preflight failed" : "model gateway connection retry failed",
    );
  }

  private async withConnectTimeout<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`模型服务连接超时(${MODEL_CONNECT_TIMEOUT_MS}ms)`));
      }, MODEL_CONNECT_TIMEOUT_MS);
    });
    try {
      if (signal?.aborted) throw new Error(MODEL_CONNECT_CANCELLED_MESSAGE);
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

class ModelGatewayConnectionError extends Error {
  override name = "ModelGatewayConnectionError";
}

class ModelGatewayRequestError extends Error {
  override name = "ModelGatewayRequestError";
}

function createModelConnectionError(
  profile: ModelProfile,
  cause: unknown,
  attempts: number,
): ModelGatewayConnectionError {
  const baseURL = profile.baseURL ?? "OpenAI 默认地址";
  const detail = errorMessage(cause);
  return new ModelGatewayConnectionError(
    [
      `模型服务连接失败：静默预检失败后，又重试 ${attempts} 次仍无法从 ${baseURL} 获得响应。`,
      `当前模型配置: provider=${profile.provider}, model=${profile.modelName}, profile=${profile.id}。`,
      `请检查 <用户目录>/.jue/config.yaml 中的 model.baseURL、model.apiKey、model.modelName 是否正确，网络/代理是否可访问。`,
      detail ? `底层错误: ${detail}` : "",
    ].filter(Boolean).join("\n"),
    { cause },
  );
}

function createModelRequestError(
  profile: ModelProfile,
  cause: unknown,
  request: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
): ModelGatewayRequestError {
  const baseURL = profile.baseURL ?? "OpenAI 默认地址";
  const detail = errorMessage(cause);
  return new ModelGatewayRequestError(
    [
      `模型请求参数错误：${baseURL} 拒绝了当前 Chat Completions 请求。`,
      `当前模型配置: provider=${profile.provider}, model=${profile.modelName}, profile=${profile.id}。`,
      `请求诊断: ${formatRequestDiagnostics(request)}。`,
      detail ? `底层错误: ${detail}` : "",
    ].filter(Boolean).join("\n"),
    { cause },
  );
}

function formatRequestDiagnostics(request: Parameters<OpenAI["chat"]["completions"]["create"]>[0]): string {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const toolNames = tools
    .map((tool) => tool.type === "function" ? tool.function?.name : undefined)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .slice(0, 8);
  const assistantToolCalls = messages.filter((message) => {
    const record = message as unknown as Record<string, unknown>;
    return Array.isArray(record.tool_calls) && record.tool_calls.length > 0;
  }).length;
  const toolResultMessages = messages.filter((message) => (message as unknown as Record<string, unknown>).role === "tool").length;
  return [
    `messages=${messages.length}`,
    `tools=${tools.length}`,
    toolNames.length > 0 ? `toolNames=${toolNames.join(",")}` : "toolNames=none",
    `toolChoice=${request.tool_choice === undefined ? "unset" : JSON.stringify(request.tool_choice)}`,
    `stream=${String(request.stream ?? false)}`,
    `streamOptions=${request.stream_options ? "enabled" : "unset"}`,
    `assistantToolCalls=${assistantToolCalls}`,
    `toolResultMessages=${toolResultMessages}`,
  ].join(" ");
}

function isNonRetriableRequestError(err: unknown): boolean {
  const status = readHttpStatus(err);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429;
}

function readHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  const response = record.response;
  if (typeof response === "object" && response !== null) {
    const res = response as Record<string, unknown>;
    if (typeof res.status === "number") return res.status;
    if (typeof res.statusCode === "number") return res.statusCode;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModelStatusChunk(value: Stream<ChatCompletionChunk> | ModelStatusChunk): value is ModelStatusChunk {
  return typeof value === "object" && value !== null && "phase" in value && "attempt" in value;
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * 把内部 Role 映射到 OpenAI 协议接受的 role。
 *
 * 当前 OpenAI 协议没有 `subagent` 角色,内部 subagent 消息当作 assistant 注入。
 */
function roleToOpenAI(role: ChatMessage["role"]): "system" | "user" | "assistant" | "tool" {
  switch (role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "tool":
      return "tool";
    case "assistant":
    case "subagent":
    default:
      return "assistant";
  }
}

function mapFinishReason(reason: string): NonNullable<ModelChunk["finishReason"]> {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "error";
  }
}

/**
 * OpenAI 流式 tool_calls 增量片段。`name` / `arguments` 都可能分多次推。
 */
interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/**
 * 把流式 tool_call 增量按 index 累加到 buffer。
 */
function accumulateToolCallDelta(
  buf: Map<number, { id: string; name: string; arguments: string }>,
  delta: OpenAIToolCallDelta,
): void {
  const idx = delta.index;
  let cur = buf.get(idx);
  if (!cur) {
    cur = { id: "", name: "", arguments: "" };
    buf.set(idx, cur);
  }
  if (delta.id) cur.id = delta.id;
  if (delta.function?.name) cur.name += delta.function.name;
  if (delta.function?.arguments) cur.arguments += delta.function.arguments;
}

/**
 * 把内部 ChatMessage 转为 OpenAI Chat Completions 消息形态。
 *
 * 关键点:
 *   - `assistant` 含 `toolCalls` 时,要把它们填到 `tool_calls` 字段
 *   - `tool` 角色必须带 `tool_call_id`,与 assistant 之前的 tool_call.id 对应
 *   - subagent 暂时映射成 assistant(OpenAI 协议无此 role)
 */
function buildOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  const role = roleToOpenAI(m.role);
  if (role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role,
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id || newId("call"),
        type: tc.type,
        function: { name: toOpenAICompatibleToolName(tc.function.name), arguments: tc.function.arguments || "{}" },
      })),
    };
  }
  if (role === "tool") {
    if (!m.toolCallId) {
      return {
        role: "assistant",
        content: `[tool_result_without_call_id:${m.name ?? "tool"}]\n${m.content}`,
      };
    }
    return {
      role,
      content: m.content,
      tool_call_id: m.toolCallId,
    };
  }
  return { role, content: m.content };
}

function toOpenAICompatibleToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 从非流式 message 中提取 tool_calls,转成内部 `ChatToolCall[]`。
 */
function extractToolCallsFromMessage(
  message: { tool_calls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string } }> } | null | undefined,
): ChatToolCall[] {
  const raw = message?.tool_calls;
  if (!raw || raw.length === 0) return [];
  return raw.map((tc) => ({
    id: tc.id,
    type: "function",
    function: {
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
    },
  }));
}
