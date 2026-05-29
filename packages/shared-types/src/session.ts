/**
 * @file session.ts
 * @module @jue/shared-types/session
 *
 * 浼氳瘽杈圭晫涓婄殑鏍囧噯鍗忚,瀹氫箟"鍓嶇 鈫?浼氳瘽灞?鈫?鏍稿績寮曟搸"浼犻€掔殑璇锋眰/鍝嶅簲/浜嬩欢缁撴瀯銆? *
 * 鍏抽敭妯″瀷:
 *   - {@link MessagePart}     : 鏂囨湰/鍥剧墖/鏂囦欢涓夌娑堟伅鍐呭,閴村埆瀛楁涓?`type`
 *   - {@link MessageDraft}    : 鍓嶇鍏ョ珯娑堟伅(鐢ㄦ埛鑳藉～鐨勬渶灏忛泦鍚?
 *   - {@link Message}         : 绯荤粺鎸佷箙鍖栨秷鎭?鍚?id/sessionId/createdAt 绛夌郴缁熷瓧娈?
 *   - {@link SessionRequest}  : 鍓嶇 鈫?寮曟搸,1 娆¤姹?1 涓璞? *   - {@link StreamEvent}     : 寮曟搸娴佸紡鍚愬嚭鐨勪簨浠?鍓嶇鎸変簨浠剁被鍨嬪閲忔覆鏌? *   - {@link SessionResponse} : 鏁磋疆璋冪敤缁撴潫鏃剁殑鏈€缁堝洖鍖?鍚?usage 涓?error
 *
 * 璁捐鍘熷垯:
 *   1. `MessageDraft` 涓?`Message` 鍒嗙,鍓嶇涓嶉渶瑕佷吉閫犵郴缁熷瓧娈?璇﹁ design.md 搂11)
 *   2. `attachments` 涓?`message.parts` 骞跺瓨:`attachments` 鐢ㄤ簬杈冨ぇ鐨勮緟鍔╄祫鏂?
 *      `parts` 鍐呰仈鍦ㄤ富娑堟伅涓? *   3. `flags` 涓哄彈鎺х殑瀛楃涓?甯冨皵/鏁板€兼爣蹇?鐢ㄤ簬浼氳瘽涓存椂寮€鍏?涓嶆斁杩?Metadata)
 */

import { z } from "zod";
import { ContextBlockSchema } from "./context.js";
import {
  ErrorInfoSchema,
  FrontendKindSchema,
  IdSchema,
  MetadataSchema,
  RoleSchema,
  SessionModeSchema,
  TimestampSchema,
  TraceContextSchema,
} from "./common.js";

/**
 * 娑堟伅鍐呭绉嶇被鐨勫懡鍚嶆灇涓俱€備粎鍋氳涔夋爣娉?鐪熸鐨?part 閴村埆鐢?{@link MessagePartSchema} 瀹屾垚銆? */
export const MessageContentTypeSchema = z.enum([
  "text",
  "markdown",
  "image",
  "file",
  "tool_call",
  "tool_result",
  "system",
]);
export type MessageContentType = z.infer<typeof MessageContentTypeSchema>;

/**
 * 鏂囨湰 part,鏈€甯哥敤鐨勬秷鎭浇浣撱€? */
export const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * 鍥剧墖 part銆俙url` 涓?`base64` 鑷冲皯瑕佹湁涓€涓?杩欐潯浜ゅ弶绾︽潫鐢?`.refine` 淇濊瘉,
 * 浠呴潬 `.optional()` 鏄笉澶熺殑(鍚﹀垯鍙互涓や釜閮界己澶?銆? */
export const ImagePartSchema = z
  .object({
    type: z.literal("image"),
    url: z.string().url().optional(),
    base64: z.string().optional(),
    mimeType: z.string().default("image/png"),
  })
  .refine((v) => Boolean(v.url) || Boolean(v.base64), {
    message: "image part 蹇呴』鑷冲皯鎻愪緵 url 鎴?base64 涔嬩竴",
    path: ["url"],
  });

/**
 * 鏂囦欢 part銆俙url`(杩滅▼涓嬭浇)涓?`path`(鏈湴鏂囦欢)鑷冲皯鏈変竴涓€? */
export const FilePartSchema = z
  .object({
    type: z.literal("file"),
    url: z.string().optional(),
    path: z.string().optional(),
    mimeType: z.string(),
    size: z.number().int().nonnegative().optional(),
    name: z.string().optional(),
  })
  .refine((v) => Boolean(v.url) || Boolean(v.path), {
    message: "file part 蹇呴』鑷冲皯鎻愪緵 url 鎴?path 涔嬩竴",
    path: ["url"],
  });

/**
 * 宸ュ叿璋冪敤 part銆俛ssistant 杩欎竴杞喅瀹氳皟鐢ㄦ煇浜涘伐鍏锋椂,鎶婃剰鍥剧洿鎺ヤ互 part 褰㈠紡
 * 鎸佷箙鍖栧湪娑堟伅閲?渚夸簬澶氳疆鍘嗗彶杩樺師(瀵归綈 OpenAI Chat Completions 鐨?tool_calls)銆? *
 *   - `callId`     : 妯″瀷缁欑殑璋冪敤 id,涓庡悗缁?tool 娑堟伅鐨?toolCallId 蹇呴』涓€鑷? *   - `toolName`   : 宸ュ叿鍚?鍐椾綑瀛樹竴浠?渚夸簬瀹¤/绱㈠紩)
 *   - `arguments`  : OpenAI 鍗忚涓嬫槸 JSON 瀛楃涓层€傝繖閲屼繚鐣欏師濮嬪瓧绗︿覆,鎵ц绔啀 parse
 */
export const ToolCallPartSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.string().default("{}"),
});

/**
 * 宸ュ叿缁撴灉 part銆俙role: "tool"` 娑堟伅鍐呮壙杞藉伐鍏锋墽琛岀粨鏋溿€? *
 *   - `callId`   : 涓?`ToolCallPart.callId` 瀵瑰簲
 *   - `toolName` : 宸ュ叿鍚?鍐椾綑,渚夸簬妫€绱?
 *   - `content`  : 宸插簭鍒楀寲銆佸彲鐩存帴鍠傜粰妯″瀷鐨勭粨鏋滄枃鏈?JSON 瀛楃涓叉垨绾枃鏈?
 *   - `isError`  : 宸ュ叿鎵ц澶辫触鏃惰 true,妯″瀷鍙嵁姝よ皟鏁村悗缁瓥鐣? */
export const ToolResultPartSchema = z.object({
  type: z.literal("tool_result"),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  content: z.string(),
  isError: z.boolean().default(false),
});

/**
 * 娑堟伅鐨勬渶灏忓唴瀹瑰崟鍏冦€傞壌鍒瓧娈垫槸 `type`,鏂板绫诲瀷鏃堕渶鍚屾鏇存柊姝?union銆? */
export const MessagePartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ImagePartSchema,
  FilePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;
export type TextPart = z.infer<typeof TextPartSchema>;
export type ImagePart = z.infer<typeof ImagePartSchema>;
export type FilePart = z.infer<typeof FilePartSchema>;
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;

/**
 * 鍏ョ珯娑堟伅鑽夌銆傜敤浜?鍓嶇 鈫?浼氳瘽灞?鐨勬彁浜ゅ崗璁€? *
 * 绯荤粺瀛楁(`id` / `sessionId` / `createdAt`)鐢变細璇濆眰鑷琛ラ綈,涓嶅簲鐢卞墠绔吉閫犮€? * 杩欐牱鑳戒繚璇佹寔涔呭寲娑堟伅鐨?id 鍏ㄥ眬鍞竴銆乧reatedAt 鏈嶅姟鍣ㄨ瑙掑噯纭€? */
export const MessageDraftSchema = z.object({
  role: RoleSchema,
  parts: z.array(MessagePartSchema).min(1),
  parentId: IdSchema.optional(),
  metadata: MetadataSchema.optional(),
});
export type MessageDraft = z.infer<typeof MessageDraftSchema>;

/**
 * 鎸佷箙鍖栨秷鎭疄浣撱€備細璇濆眰鍦ㄦ敹鍒?{@link MessageDraft} 鍚?琛ラ綈绯荤粺瀛楁鍚庤惤搴撱€? * 鍚屾牱鐢ㄤ簬 SessionResponse 涓殑 `finalMessage`銆? */
export const MessageSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  role: RoleSchema,
  parts: z.array(MessagePartSchema).min(1),
  createdAt: TimestampSchema,
  parentId: IdSchema.optional(),
  metadata: MetadataSchema.optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * 鍓嶇鑳藉姏鎻忚堪銆傚紩鎿庢嵁姝ゅ喅瀹氭槸鍚﹀惎鐢ㄦ祦寮忋€佸瘜鏂囨湰銆佸伐鍏疯皟鐢ㄩ潰鏉跨瓑銆? * 渚?CLI 娌℃湁 `images`銆佺函 API 璋冪敤閫氬父娌℃湁 `confirmDialog`銆? */
export const FrontendCapabilitiesSchema = z.object({
  streaming: z.boolean().default(true),
  markdown: z.boolean().default(true),
  images: z.boolean().default(false),
  files: z.boolean().default(false),
  tools: z.boolean().default(true),
  confirmDialog: z.boolean().default(false),
  notifications: z.boolean().default(false),
});
export type FrontendCapabilities = z.infer<typeof FrontendCapabilitiesSchema>;

/**
 * 浼氳瘽璇锋眰銆傚墠绔瀯閫?浼氳瘽灞傛帴鏀跺悗杞氦寮曟搸銆? *
 * - `requestId`    : 鍗曟璇锋眰鐨勫叏灞€鍞竴 id,鐢ㄤ簬瀹¤涓庢祦浜嬩欢褰掑睘
 * - `sessionId`    : 浼氳瘽缁村害 id,鐢ㄤ簬璺ㄨ姹傚鐢ㄤ笂涓嬫枃/璁板繂
 * - `attachments`  : 涓庢湰杞秷鎭竴鍚屾彁浜や絾涓嶇洿鎺ュ祵鍏?`message.parts` 鐨勮祫鏂? * - `flags`        : 涓存椂寮€鍏?濡?`noStream / verbose / dryRun`),涓嶈繘鍏ユ寔涔呭寲
 */
export const SessionRequestSchema = z.object({
  requestId: IdSchema,
  sessionId: IdSchema,
  userId: IdSchema,
  frontend: FrontendKindSchema,
  mode: SessionModeSchema.default("chat"),
  capabilities: FrontendCapabilitiesSchema.optional(),
  message: MessageDraftSchema,
  trace: TraceContextSchema.optional(),
  attachments: z.array(MessagePartSchema).default([]),
  flags: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).default({}),
  persistedContextBlocks: z.array(ContextBlockSchema).default([]),
  createdAt: TimestampSchema,
});
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

/**
 * 寮曟搸鍦ㄦ墽琛岃繃绋嬩腑鍚戝墠绔帹閫佺殑浜嬩欢绫诲瀷銆? *
 * 鍛藉悕瑙勫垯:`<鍩?.<鍔ㄤ綔>` 鍙屾寮?鍓嶇鎸?`type` 鍋氬垎鍙戙€? *
 * - `model.delta` 涓?`model.token` 鍏卞瓨鐨勫師鍥?
 *   涓嶅悓 LLM provider 杈撳嚭绮掑害涓嶅悓,`token` 琛ㄧず绮剧‘鍒颁竴涓?token,`delta` 琛ㄧず涓€娈垫枃鏈潡
 */
export const StreamEventTypeSchema = z.enum([
  "session.started",
  "model.token",
  "model.delta",
  "model.status",
  "tool.invocation.started",
  "tool.invocation.progress",
  "tool.invocation.completed",
  "subagent.started",
  "subagent.progress",
  "subagent.completed",
  "context.compressed",
  "context.budget.updated",
  "memory.recorded",
  "warning",
  "error",
  "session.completed",
]);
export type StreamEventType = z.infer<typeof StreamEventTypeSchema>;

/**
 * 娴佸紡浜嬩欢鍖呫€俙payload` 鏁呮剰淇濈暀 `unknown`,鍏蜂綋褰㈢姸鐢卞悇浜嬩欢绫诲瀷鑷绾﹀畾,
 * 閬垮厤鍦ㄥ叡浜被鍨嬩腑鍫嗙爩杩囧 union(鍏蜂綋褰㈢姸鏀惧湪鐢熶骇浜嬩欢鐨勫寘鍐呮弿杩?銆? */
export const StreamEventSchema = z.object({
  eventId: IdSchema,
  sessionId: IdSchema,
  requestId: IdSchema,
  type: StreamEventTypeSchema,
  at: TimestampSchema,
  payload: z.unknown().optional(),
  trace: TraceContextSchema.optional(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * 鍗曡疆璇锋眰鐨勮祫婧愭秷鑰楁眹鎬?涓昏鐢ㄤ簬璁¤垂銆佺洃鎺т笌閰嶉闄愬埗銆? */
export const SessionUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  toolCallCount: z.number().int().nonnegative().default(0),
  subAgentCallCount: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/**
 * 鏁磋疆璇锋眰鐨勬渶缁堝洖鍖呫€? *
 * - 娴佸紡鍦烘櫙:鍓嶇鍏堟秷璐?{@link StreamEvent} 搴忓垪,鏈€鍚庢敹鍒颁竴涓?SessionResponse 鏀跺熬
 * - 闈炴祦寮忓満鏅?鏁翠釜 SessionResponse 涓€娆℃€ц繑鍥?`events` 涓哄畬鏁翠簨浠跺洖鏀? */
export const SessionResponseSchema = z.object({
  requestId: IdSchema,
  sessionId: IdSchema,
  finished: z.boolean(),
  finalMessage: MessageSchema.optional(),
  events: z.array(StreamEventSchema).default([]),
  usage: SessionUsageSchema.optional(),
  error: ErrorInfoSchema.optional(),
  finishedAt: TimestampSchema.optional(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/**
 * 浼氳瘽蹇収,鐢ㄤ簬浼氳瘽鍒楄〃/鎭㈠鍦烘櫙銆備笉鎼哄甫鍏蜂綋娑堟伅鍐呭銆? */
export const SessionSnapshotSchema = z.object({
  sessionId: IdSchema,
  userId: IdSchema,
  frontend: FrontendKindSchema,
  mode: SessionModeSchema,
  startedAt: TimestampSchema,
  lastActiveAt: TimestampSchema,
  messageCount: z.number().int().nonnegative().default(0),
  metadata: MetadataSchema.optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

