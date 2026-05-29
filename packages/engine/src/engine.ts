/**
 * @file engine.ts
 * @module @jue/engine/engine
 *
 * Core engine layer: model calls, agent loop, tool orchestration,
 * context compaction triggers, and memory write events.
 * This layer consumes SessionRequest and emits StreamEvent; it is frontend-agnostic.
 */

import {
  type AuditLogger,
  defaultTokenEstimator,
  getModuleLogger,
  newId,
} from "@jue/utils";
import type {
  ErrorInfo,
  ContextBlock,
  Id,
  Message,
  MessagePart,
  SessionRequest,
  SessionResponse,
  SessionUsage,
  StreamEvent,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "@jue/shared-types";
import type { ContextManager } from "@jue/context";
import { isExplicitMemorySignal, type MemoryManager } from "@jue/memory";
import type { PromptManager, PromptRuntimeContext } from "@jue/prompting";
import { CompactionSubAgentRunnerAdapter, LlmCompactionSubAgentRunner, RuleCompactionSubAgentRunner, createCompactionSubAgentRegistration, type SubAgentNotification, type SubAgentRegistry } from "@jue/subagent";
import type { ToolRegistry } from "@jue/tools";

import type {
  ModelChunk,
  ModelGateway,
  ModelToolDefinition,
} from "./model-gateway.js";
import {
  DefaultPolicyGuard,  MissingToolOrchestrator,
  type PolicyGuard,  type ToolOrchestrator,
} from "./orchestrators.js";

export interface EngineRuntimeMeta {
  appEnv?: string;
  defaultLanguage?: string;
  defaultTimezone?: string;
  workspaceRoot?: string;
  environment?: Record<string, string | number | boolean>;
  availableSkills?: PromptRuntimeContext["availableSkills"];
  availableSubAgents?: PromptRuntimeContext["availableSubAgents"];
  drainSubAgentNotifications?: (sessionId: Id) => SubAgentNotification[];
  memoryIndexBlocks?: ContextBlock[];
  getObservationHints?: (limit?: number) => string[];
  markFormalMemoryWritten?: (input: { sessionId: Id; requestId: Id; callId?: Id; records?: unknown[] }) => void;
  hasFormalMemoryWritten?: (input: { sessionId: Id; requestId: Id }) => boolean;
}
export interface AgentEngineOptions {
  promptManager: PromptManager;
  contextManager: ContextManager;
  modelGateway: ModelGateway;
  toolRegistry: ToolRegistry;
  memoryManager: MemoryManager;
  subAgentRegistry: SubAgentRegistry;
  auditLogger: AuditLogger;
  toolOrchestrator?: ToolOrchestrator;  policyGuard?: PolicyGuard;
  runtimeMeta?: EngineRuntimeMeta;
  toolResultRepository?: EngineToolResultRepository;
  transcriptSink?: EngineTranscriptSink;
  compressionPersistence?: EngineCompressionPersistencePolicy;
  maxLoopIters?: number;
}

export interface EngineHandleOutput {
  events: AsyncIterable<StreamEvent>;
  done: Promise<SessionResponse>;
}

export interface EnginePersistedToolResultSummary {
  callId: Id;
  toolName: string;
  status: string;
  resultRef: string;
  summary?: string;
  tokenEstimate: number;
  durationMs: number;
  persistedAt: number;
}

export interface EngineToolResultRepository {
  persist(input: {
    sessionId: Id;
    requestId: Id;
    call: ToolCall;
    result: ToolResult;
    contextContent: string;
    modelContent: string;
  }): EnginePersistedToolResultSummary;
}

export interface EngineTranscriptSink {
  appendToolResultPersisted(input: { sessionId: Id; requestId: Id; payload: EnginePersistedToolResultSummary }): void;
  appendContextCompression?(input: { sessionId: Id; requestId: Id; payload: EngineDurableCompressionPayload }): void;
  appendDurableCompression?(input: { sessionId: Id; requestId: Id; payload: EngineDurableCompressionPayload }): void;
}

export interface EngineDurableCompressionPayload extends Record<string, unknown> {
  persisted: true;
  persistenceReason: string;
  persistedBlocks: ContextBlock[];
  requestId: Id;
  compressedBlockIds: Id[];
  droppedBlockIds: Id[];
  cacheHitKeys: string[];
  pressure?: string;
  totalTokens?: number;
  blockCount?: number;
  summaryRefs?: Array<{ blockId: Id; summaryRef: Id }>;
  strategyVersion?: string;
}

export interface EngineCompressionPersistencePolicy {
  autoPersist?: boolean;
  pressureLevels?: Array<"llm_compress" | "overflow">;
}

type AbortableSessionRequest = SessionRequest & { signal?: AbortSignal };

export interface ContextCompressionDebugInput {
  sessionId: Id;
  requestId?: Id;
  userId: Id;
  frontend: SessionRequest["frontend"];
  mode?: SessionRequest["mode"];
  history: Message[];
  flags?: Record<string, string | boolean | number>;
}

export interface ContextCompressionDebugResult {
  sessionId: Id;
  requestId: Id;
  pressure: string;
  totalTokens: number;
  blockCount: number;
  droppedBlockIds: Id[];
  compressedBlockIds: Id[];
  cacheHitKeys: string[];
  blocks: Array<{
    id: Id;
    type: string;
    source: string;
    tokenEstimate: number;
    pinned: boolean;
    compressible: boolean;
    relevance: number;
    summaryRef?: Id;
    compressionStrategy?: string;
    compressedBy?: string;
    compactionNotice?: string;
    fallbackReason?: string;
    persisted?: boolean;
    sourceBlockIds?: Id[];
    sourceMessageIds?: Id[];
    preview: string;
  }>;
  persistedBlocks: ContextBlock[];
}

export interface SessionSummaryInput {
  sessionId: Id;
  requestId?: Id;
  userId: Id;
  frontend: SessionRequest["frontend"];
  mode?: SessionRequest["mode"];
  history: Message[];
  previousSummary?: string;
  trigger: "agent_close" | "manual_compressor" | "auto_compressor";
}

export interface SessionSummaryResult {
  sessionId: Id;
  requestId: Id;
  trigger: SessionSummaryInput["trigger"];
  markdown: string;
  sourceBlockIds: Id[];
  status: "succeeded" | "fallback";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    durationMs?: number;
  };
}
export class AgentEngine {
  private readonly logger = getModuleLogger("engine");
  private readonly promptManager: PromptManager;
  private readonly contextManager: ContextManager;
  private readonly modelGateway: ModelGateway;
  private readonly toolRegistry: ToolRegistry;
  private readonly memoryManager: MemoryManager;
  private readonly subAgentRegistry: SubAgentRegistry;
  private readonly auditLogger: AuditLogger;
  private readonly toolOrchestrator: ToolOrchestrator;  private readonly policyGuard: PolicyGuard;
  private readonly runtimeMeta: EngineRuntimeMeta;
  private readonly toolResultRepository: EngineToolResultRepository | undefined;
  private readonly transcriptSink: EngineTranscriptSink | undefined;
  private readonly compressionPersistence: EngineCompressionPersistencePolicy;
  private readonly modelToolNameToInternalName = new Map<string, string>();
  private readonly maxLoopIters: number;

  constructor(options: AgentEngineOptions) {
    this.promptManager = options.promptManager;
    this.contextManager = options.contextManager;
    this.modelGateway = options.modelGateway;
    this.toolRegistry = options.toolRegistry;
    this.memoryManager = options.memoryManager;
    this.subAgentRegistry = options.subAgentRegistry;
    this.auditLogger = options.auditLogger;
    this.toolOrchestrator = options.toolOrchestrator ?? new MissingToolOrchestrator();
    this.policyGuard = options.policyGuard ?? new DefaultPolicyGuard();
    this.runtimeMeta = options.runtimeMeta ?? {};
    this.toolResultRepository = options.toolResultRepository;
    this.transcriptSink = options.transcriptSink;
    this.compressionPersistence = options.compressionPersistence ?? { autoPersist: false, pressureLevels: ["overflow"] };
    this.maxLoopIters = options.maxLoopIters ?? 32;
    void this.subAgentRegistry;
    void this.logger;
  }
  handle(req: SessionRequest, history: Message[]): EngineHandleOutput {
    const abortSignal = (req as AbortableSessionRequest).signal;
    let resolveDone!: (value: SessionResponse) => void;
    const done = new Promise<SessionResponse>((res) => {
      resolveDone = res;
    });

    const self = this;
    const events = (async function* (): AsyncIterable<StreamEvent> {
      const startedAt = Date.now();
      const collectedEvents: StreamEvent[] = [];
      const emit = (ev: StreamEvent): StreamEvent => {
        collectedEvents.push(ev);
        return ev;
      };

      try {
        yield emit(
          self.makeEvent(req, "session.started", { mode: req.mode, frontend: req.frontend }),
        );

        self.auditLogger.log({
          category: "session",
          action: "started",
          actor: { kind: "user", id: req.userId, frontend: req.frontend },
          target: { kind: "session", id: req.sessionId },
          sessionId: req.sessionId,
          requestId: req.requestId,
          outcome: "success",
        });

        // 1. Prompt
        const runtimeCtx = self.buildPromptRuntimeContext(req);
        const built = self.promptManager.build(runtimeCtx);
        const userMessage: Message = {
          id: newId("msg"),
          sessionId: req.sessionId,
          role: req.message.role,
          parts: req.message.parts,
          createdAt: req.createdAt,
          ...(req.message.parentId ? { parentId: req.message.parentId } : {}),
          ...(req.message.metadata ? { metadata: req.message.metadata } : {}),
        };
        const maxLoopIters = self.maxLoopIters;
        const loopHistory: Message[] = [...history, userMessage];
        const allAssistantMessages: Message[] = [];
        let totalUsage: SessionUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          toolCallCount: 0,
          subAgentCallCount: 0,
          durationMs: 0,
        };
        let lastFinishReason: ModelChunk["finishReason"];
        let assembledFinalText = "";
        let formalMemoryWrittenThisTurn = self.runtimeMeta.hasFormalMemoryWritten?.({ sessionId: req.sessionId, requestId: req.requestId }) ?? false;

        for (let iter = 0; iter < maxLoopIters; iter++) {
          if (abortSignal?.aborted) {
            yield emit(self.makeEvent(req, "warning", { code: "USER_ABORTED", message: "User aborted the current run." }));
            break;
          }
          const pendingSubAgentNotifications = self.runtimeMeta.drainSubAgentNotifications?.(req.sessionId) ?? [];
          const currentUserInputText = messageText(userMessage);
          const shouldSkipObservationForStrongSignal = isExplicitMemorySignal(currentUserInputText);
          const observationResult = iter === 0 && !formalMemoryWrittenThisTurn
            ? await self.memoryManager.observeUserMessage({
                text: currentUserInputText,
                sessionId: req.sessionId,
                requestId: req.requestId,
                userId: req.userId,
                ...(self.runtimeMeta.workspaceRoot ? { workspaceRoot: self.runtimeMeta.workspaceRoot } : {}),
                skipStrongSignalExtraction: true,
                skipObservation: shouldSkipObservationForStrongSignal,
              })
            : undefined;
          const observationHints = buildObservationHints(observationResult, self.runtimeMeta.getObservationHints?.(1) ?? []);
          // Long-term memory is injected through indexed context blocks; the model can read detail files when needed.
          const memoryRecords: import("@jue/shared-types").MemoryRecord[] = [];
          const memoryBlocks = self.runtimeMeta.memoryIndexBlocks ?? [];
          const contextBuild = await self.contextManager.buildForMainAgent({
            sessionId: req.sessionId,
            requestId: req.requestId,
            systemPromptText: built.text,
            systemPromptSnapshotId: built.snapshotId,
            recentMessages: loopHistory,
            currentUserInputText,
            memoryRecords,
            memoryBlocks,
            attachments: req.attachments,
            taskState: renderTaskState(req.mode, pendingSubAgentNotifications, observationHints),
            persistedCompressedBlocks: req.persistedContextBlocks,
          });
          const { messages } = contextBuild;
          yield emit(self.makeEvent(req, "context.budget.updated", buildContextBudgetPayload(contextBuild)));
          if (hasContextCompaction(contextBuild)) {
            const compressionPayload = buildContextCompressedPayload(contextBuild);
            yield emit(self.makeEvent(req, "context.compressed", compressionPayload));
            const durablePayload = self.buildDurableCompressionPayload(req, contextBuild, compressionPayload);
            if (durablePayload) {
              self.transcriptSink?.appendDurableCompression?.({
                sessionId: req.sessionId,
                requestId: req.requestId,
                payload: durablePayload,
              });
            }
          }

          const tools = self.buildModelToolDefinitions(req);

          let assembled = "";
          let toolCalls: ToolCall[] = [];
          for await (const chunk of self.modelGateway.invoke({
            messages,
            stream: true,
            ...(abortSignal ? { signal: abortSignal } : {}),
            ...(tools.length > 0 ? { tools, toolChoice: "auto" } : {}),
          })) {
            if (abortSignal?.aborted) break;
            if (chunk.type === "status" && chunk.status) {
              yield emit(self.makeEvent(req, "model.status", chunk.status));
            } else if (chunk.type === "delta" && chunk.delta) {
              assembled += chunk.delta;
              yield emit(self.makeEvent(req, "model.delta", { delta: chunk.delta }));
            } else if (chunk.type === "finish") {
              lastFinishReason = chunk.finishReason;
              mergeUsage(totalUsage, chunk.usage);
              if (chunk.toolCalls && chunk.toolCalls.length > 0) {
                toolCalls = chunk.toolCalls.map((tc) => ({
                  id: tc.id,
                  toolName: self.toInternalToolName(tc.function.name),
                  ...parseToolCallArguments(tc.function.arguments),
                  invokedBy: "agent" as const,
                  sessionId: req.sessionId,
                  requestId: req.requestId,
                  createdAt: Date.now(),
                }));
              }
            }
          }
          const assistantParts: MessagePart[] = [];
          if (assembled) assistantParts.push({ type: "text", text: assembled });
          for (const tc of toolCalls) {
            assistantParts.push({
              type: "tool_call",
              callId: tc.id,
              toolName: tc.toolName,
              arguments: JSON.stringify(tc.arguments),
            });
          }
          if (assistantParts.length > 0) {
            const aMsg: Message = {
              id: newId("msg"),
              sessionId: req.sessionId,
              role: "assistant",
              parts: assistantParts,
              createdAt: Date.now(),
            };
            loopHistory.push(aMsg);
            allAssistantMessages.push(aMsg);
          }
          if (assembled) assembledFinalText = assembled;

          if (toolCalls.length === 0) break; // 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健楠炴劖绻濋崘顏嗗骄闂佸啿鎼鍥╃矓椤旈敮鍋撶憴鍕８闁告梹鍨甸锝夊醇閺囩偟顓哄┑鐘绘涧閻楀啴宕戦幘娲绘晣闁绘垵妫欑€靛矂姊洪棃娑氬闁硅櫕鍔楃划缁樺鐎涙鍘藉┑掳鍊愰崑鎾翠繆椤愶絿绠炴鐐插暣閹瑩宕崟顐も偓顓烆渻閵堝棗濮夊┑顔肩－閼鸿鲸绻濆顓涙嫼闂佽崵鍠撴晶妤呭箚閸喍绻嗘い鎰剁秵濞堟洜绱掗崒姘毙х€规洘绮忛ˇ瀵哥棯閹佸仮闁哄本鐩獮妯何旈埀顒€螞濞嗘搩鏁佹俊銈呮噺閳锋垿鏌涘☉姗堝姛闁瑰啿鍟撮弻娑㈡偄閸涘﹦绋囬梺浼欑到閸㈣尙鍙呭銈呯箰鐎氼噣宕濋敃鈧—鍐Χ閸℃鐟愰梻鍌氬缁夌數绮嬪鍜佺叆闁割偆鍠撻崢鐢告⒑缂佹ê鐏﹂柨姘舵煟韫囧鍔滈柕鍥у缁犳盯鏁愰崟顖氫粣闂備礁鎼径鍥礈濠靛绠柛娑欐綑缁狅綁鏌熼悜妯虹仸闁稿孩鎸剧槐鎾诲磼濞嗘劗銈版俊鐐存綑閹芥粓寮鈧幃娆撳传閸曨厼濮︽俊鐐€栫敮鎺楁晝閿斿墽鐭撻梻鍫熻€介悷閭︾叆闁糕剝顭囬妴鎰版煕濡ゅ懍鎲鹃柡灞剧☉閳藉顫滈崱娆忓Ъ濠电偛鐡ㄧ划宥囧垝閹捐钃熼柣鏃傚帶缁€鍫㈡喐瀹ュ棛顩锋繛宸簼閻撴洟鎮楅敐鍐ㄥ闁诲浚鍣ｉ弻宥堫檨闁告挻绻堥敐鐐村緞婵炴帡缂氱粻娑樷槈濡⒈妲烽梻浣侯攰閹活亞鎷归悢鐓庣劦妞ゆ垼娉曢ˇ锔姐亜椤愶絿鐭掗柛鈹惧亾濡炪倖甯掔€氼剛绮婚弽顓熺厪闊洤顑呴埀顒佹礃鐎靛ジ鎮╃紒妯煎帾婵犮垼娉涢悧鍡涘礉閵堝洨纾煎ù锝呮惈閸樺瓨鎱ㄦ繝鍌ょ吋鐎规洘甯掗～婵嬵敄閽樺澹曢悗鐟板閸ｇ銇愰幒鎴犲€為悷婊冪箻瀵娊鏁冮崒娑氬幈濡炪値鍘介崹鍨濠靛鐓曟繛鍡楃箳缁犲鏌″畝鈧崰鎾舵閹烘顫呴柣妯虹－瑜邦垶姊绘担鑺ャ€冪紒鈧担琛″亾濮橆偄宓嗙€殿喛顕ч埥澶娢熼柨瀣垫綌婵犵數鍋涘Λ娆撳礉濡ゅ啰鐭欓柛銉墯閳锋垶鎱ㄩ悷鐗堟悙闁逞屽厵閸婃繂鐣烽弶璇炬棃宕ㄩ鍥风畵閺屾盯寮撮妸銉т哗缂備胶濮甸惄顖炲蓟濞戙垹绠婚柤纰卞墻濡差噣姊虹化鏇熸珔闁兼椿鍨堕垾鏃堝礃椤斿槈褔鏌涢埄鍐剧劷妞わ妇澧楃换娑氣偓娑欘焽閻﹪鏌ｉ弽顐㈠付妞ゆ洩绲剧换婵嗩潩椤撶偘绨婚梻浣侯焾缁绘帡宕㈣缁傚秹鏌嗗鍡忔嫼闂佸憡鎸昏ぐ鍐╃閻愮儤鐓曢柣妯挎珪瀹曞瞼鈧娲橀悷鈺呭极瀹ュ绀嬫い鎾跺缁卞啿鈹戦悙鑸靛涧缂佸弶宕橀妵鎰板礃閳哄喚娲?闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁惧墽鎳撻—鍐偓锝庝簼閹癸綁鏌ｉ鐐搭棞闁靛棙甯掗～婵嬫晲閸涱剙顥氬┑掳鍊楁慨鐑藉磻閻愮儤鍋嬮柣妯荤湽閳ь兛绶氬鎾閳╁啯鐝曢梻浣藉Г閿氭い锔诲枤缁辨棃寮撮悢铏圭槇闂佹眹鍨藉褍鐡梻浣瑰濞插繘宕愬┑瀣畺鐟滄柨鐣烽崡鐐╂瀻闁瑰濮烽崝鍫曟⒒娴ｇ顥忛柛瀣瀹曚即骞樼捄鍝勑氶梺閫炲苯澧存慨濠傤煼瀹曟帒顫濋崡鐑嗘澑濠电偞鎸荤喊宥夈€冩繝鍌滄殾闁哄洢鍨圭粻娑㈡煟濡も偓閻楀繘宕㈤柆宥嗙厽閹兼惌鍨抽崚浼存煕濮橈絽浜鹃梻鍌欑贰閸欏酣宕归崼鏇炶摕闁挎稑瀚▽顏堟煕閹炬瀚崹閬嶆⒒娴ｈ櫣銆婇柡鍛〒閳ь剚纰嶅姗€鎮惧畡閭︽建闁逞屽墴閵嗕線寮埀顒勫箯閸涱垱瀚氶柍鈺佸暟缁夐箖姊婚崒姘偓鎼佸磹閻戣姤鍤勯柛鎾茬閸ㄦ繃銇勯弽顐粶缂佲偓婢舵劖鐓涢柛銉ｅ劚閻忣亪鏌￠崨顔剧畺闁靛洤瀚粻娑㈠箻鐠轰警鏆梻浣芥閸熶即宕伴弽顓炶摕闁靛鍎弨浠嬫煕閳锯偓閺呮粎鐟х紓鍌氬€烽懗鑸垫叏閻㈢數鐭欓柟鐑橆殔妗呴梺鍛婃处閸ㄦ壆鐚惧澶嬬厱闁靛鍠氭禒銏ゆ煙閹呮憼闁告瑥绻橀弻銊モ攽閸℃ê娅ｅ銈呮禋閸樹粙骞堥妸锔剧瘈闁告侗鍣禒鈺佲攽閻愭潙鐏╅柡浣筋嚙閻ｇ兘濡搁埡濠冩櫍婵犮垼娉涢鍡欎焊閹殿喚纾肩紓浣诡焽濞叉挳鏌熷畷鍥р枅妞ゃ垺顨婇崺鈧い鎺戝閸戠姵绻涢幋鐐垫噽婵炲牅绮欓弻锝夊箛椤撶偟绁烽梺鍝勬閻熲晠骞楅崼鏇炲唨妞ゆ挾鍠撻崢鍗炩攽閻愭潙鐏ョ€规洦鍓熷绋库槈濡繐缍婇幃顏堝焵椤掑嫬鐭楅柛鎰电厛濞兼牠鏌ц箛鎾磋础缁炬儳鍚嬮幈銊ノ旈埀顒€螞濞嗘挻鍋╅柛顐ｆ礃閳锋垹绱撴担鐧镐緵婵炲牊妫冮弻銊╁即閵娿倝鍋楅梺缁樹緱閸犳稓绮诲☉妯锋婵炲棙鍨垫慨鎼佹煟鎼达紕鐣柛搴″船铻炵€光偓閸曨偆顔?
          if (abortSignal?.aborted) {
            yield emit(self.makeEvent(req, "warning", { code: "USER_ABORTED", message: "User aborted the current run." }));
            break;
          }
          totalUsage.toolCallCount += toolCalls.length;
          for (const call of toolCalls) {
            if (abortSignal?.aborted) break;
            yield emit(
              self.makeEvent(req, "tool.invocation.started", {
                callId: call.id,
                toolName: call.toolName,
                arguments: call.arguments,
              }),
            );
            const guard = await self.policyGuard.checkToolCall(call);
            let result: ToolResult;
            if (!guard.allowed) {
              result = denyToolResult(call, guard.reason ?? "policy denied");
            } else {
              result = await self.toolOrchestrator.dispatch(call);
            }
            const contextContent = serializeToolResultForContext(result);
            const serialized = serializeToolResultForModel(result);
            if (call.toolName === "memory.write" && result.status === "succeeded") {
              const records = extractWrittenMemoryRecords(result.output);
              formalMemoryWrittenThisTurn = true;
              self.runtimeMeta.markFormalMemoryWritten?.({ sessionId: req.sessionId, requestId: req.requestId, callId: call.id, records });
              yield emit(self.makeEvent(req, "memory.recorded", { action: "write", written: records }));
            }
            const persistedToolResult = self.persistToolResult(req, call, result, contextContent, serialized.content);
            self.contextManager.getToolResultStore().add({
              kind: inferToolResultKind(call.toolName),
              toolName: call.toolName,
              content: contextContent,
              sessionId: req.sessionId,
              requestId: req.requestId,
              callId: call.id,
              ...(result.summary ? { summary: result.summary } : {}),
              relevance: call.relevanceScore,
              createdAt: Date.now(),
              metadata: {
                status: result.status,
                relevanceScore: call.relevanceScore,
                ...(persistedToolResult ? { resultRef: persistedToolResult.resultRef } : {}),
              },
            });
            self.auditLogger.log({
              category: "tool_call",
              action: result.status,
              actor: { kind: "agent" },
              target: { kind: "tool", id: call.toolName },
              sessionId: req.sessionId,
              requestId: req.requestId,
              outcome: result.status === "succeeded" ? "success" : "failure",
              payloadSummary: `${call.toolName} ${result.status} ${result.durationMs}ms`,
              ...(result.status !== "succeeded" && result.error
                ? { reason: `${result.error.code}: ${result.error.message}` }
                : {}),
            });
            yield emit(
              self.makeEvent(req, "tool.invocation.completed", {
                callId: call.id,
                toolName: call.toolName,
                status: result.status,
                ...(persistedToolResult ? { resultRef: persistedToolResult.resultRef } : {}),
                ...(result.error ? { error: result.error } : {}),
                ...(result.summary ? { summary: result.summary } : {}),
              }),
            );

            const tMsg: Message = {
              id: newId("msg"),
              sessionId: req.sessionId,
              role: "tool",
              parts: [
                {
                  type: "tool_result",
                  callId: call.id,
                  toolName: call.toolName,
                  content: serialized.content,
                  isError: serialized.isError,
                },
              ],
              createdAt: Date.now(),
            };
            loopHistory.push(tMsg);
          }

          if (iter === maxLoopIters - 1) {
            yield emit(
              self.makeEvent(req, "warning", {
                code: "AGENT_LOOP_HARD_STOP",
                message: `Agent loop reached hard stop (${maxLoopIters} iterations).`,
              }),
            );
          }
        }
        const finalMessage =
          [...allAssistantMessages]
            .reverse()
            .find((m) => m.parts.some((p) => p.type === "text" && p.text.length > 0)) ??
          {
            id: newId("msg"),
            sessionId: req.sessionId,
            role: "assistant" as const,
            parts: [{ type: "text" as const, text: assembledFinalText }],
            createdAt: Date.now(),
          };

        totalUsage.durationMs = Date.now() - startedAt;
        if (totalUsage.completionTokens === 0 && assembledFinalText) {
          const est = defaultTokenEstimator.estimate(assembledFinalText);
          totalUsage.completionTokens = est;
          totalUsage.totalTokens = (totalUsage.promptTokens ?? 0) + est;
        }

        yield emit(self.makeEvent(req, "session.completed", { usage: totalUsage }));

        self.auditLogger.log({
          category: "model_call",
          action: "completed",
          actor: { kind: "agent" },
          target: { kind: "session", id: req.sessionId },
          sessionId: req.sessionId,
          requestId: req.requestId,
          outcome: "success",
          payloadSummary: `tokens=${totalUsage.totalTokens} tools=${totalUsage.toolCallCount} duration=${totalUsage.durationMs}ms finish=${lastFinishReason ?? "?"}`,
        });

        const response: SessionResponse = {
          requestId: req.requestId,
          sessionId: req.sessionId,
          finished: true,
          finalMessage,
          events: collectedEvents,
          usage: totalUsage,
          finishedAt: Date.now(),
        };

        resolveDone(response);

      } catch (err) {
        const error: ErrorInfo = {
          code: "ENGINE_INVOKE_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retriable: false,
        };
        self.logger.error({ err, requestId: req.requestId }, "engine handle failed");
        yield emit(self.makeEvent(req, "error", { error }));
        self.auditLogger.log({
          category: "model_call",
          action: "failed",
          actor: { kind: "agent" },
          target: { kind: "session", id: req.sessionId },
          sessionId: req.sessionId,
          requestId: req.requestId,
          outcome: "failure",
          severity: "error",
          reason: error.message,
        });
        const response: SessionResponse = {
          requestId: req.requestId,
          sessionId: req.sessionId,
          finished: true,
          events: collectedEvents,
          error,
          finishedAt: Date.now(),
        };
        resolveDone(response);
      }
    })();

    return { events, done };
  }
  async compressContextForDebug(input: ContextCompressionDebugInput): Promise<ContextCompressionDebugResult> {
    const requestId = input.requestId ?? newId("req");
    const req: SessionRequest = {
      requestId,
      sessionId: input.sessionId,
      userId: input.userId,
      frontend: input.frontend,
      mode: input.mode ?? "chat",
      message: { role: "user", parts: [{ type: "text", text: "/compressor" }] },
      attachments: [],
      persistedContextBlocks: [],
      flags: { ...(input.flags ?? {}), compressor: true, debugContext: true },
      createdAt: Date.now(),
    };
    const built = this.promptManager.build(this.buildPromptRuntimeContext(req));
    const result = await this.contextManager.buildForMainAgent({
      sessionId: req.sessionId,
      requestId: req.requestId,
      systemPromptText: built.text,
      systemPromptSnapshotId: built.snapshotId,
      recentMessages: input.history,
      taskState: `mode=${req.mode}; command=/compressor`,
      forceRuleCompression: true,
      forceLlmCompression: true,
      preserveRecentMessageCount: 2,
    });
    return {
      sessionId: req.sessionId,
      requestId: req.requestId,
      pressure: result.pressure,
      totalTokens: result.assembly.totalTokens,
      blockCount: result.assembly.blocks.length,
      droppedBlockIds: result.assembly.droppedBlockIds,
      compressedBlockIds: result.compressedBlockIds,
      cacheHitKeys: result.cacheHitKeys,
      persistedBlocks: result.assembly.blocks.filter(isPersistableCompressedBlock),
      blocks: result.assembly.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        source: block.source,
        tokenEstimate: block.tokenEstimate,
        pinned: block.pinned,
        compressible: block.compressible,
        relevance: block.relevance,
        ...(block.summaryRef ? { summaryRef: block.summaryRef } : {}),
        compressionStrategy: block.compressionStrategy,
        ...(typeof block.metadata?.compressedBy === "string" ? { compressedBy: block.metadata.compressedBy } : {}),
        ...(typeof block.metadata?.compactionNotice === "string" ? { compactionNotice: block.metadata.compactionNotice } : {}),
        ...(typeof block.metadata?.fallbackReason === "string" ? { fallbackReason: block.metadata.fallbackReason } : {}),
        ...(block.metadata?.persisted === true ? { persisted: true } : {}),
        ...(Array.isArray(block.metadata?.sourceBlockIds)
          ? { sourceBlockIds: block.metadata.sourceBlockIds.filter((id): id is Id => typeof id === "string") }
          : {}),
        ...(Array.isArray(block.metadata?.sourceMessageIds)
          ? { sourceMessageIds: block.metadata.sourceMessageIds.filter((id): id is Id => typeof id === "string") }
          : {}),
        preview: previewDebugContent(block.content),
      })),
    };
  }

  async summarizeSessionForStorage(input: SessionSummaryInput): Promise<SessionSummaryResult> {
    const requestId = input.requestId ?? newId("req");
    const now = Date.now();
    const historyContent = renderMessagesForSessionSummary(input.history);
    const previousSummary = input.previousSummary?.trim();
    const blocks: ContextBlock[] = [
      {
        id: newId("ctxb"),
        type: "recent_messages",
        source: "session",
        priority: 90,
        tokenEstimate: defaultTokenEstimator.estimate(historyContent),
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
        relevance: 1,
        pinned: false,
        compressible: true,
        compressionStrategy: "summary",
        sensitivity: "internal",
        content: historyContent || "No messages to summarize.",
        rawRef: { kind: "other", id: input.sessionId },
        tags: ["session_summary", "full_history"],
        metadata: { trigger: input.trigger },
      },
    ];
    if (previousSummary) {
      blocks.unshift({
        id: newId("ctxb"),
        type: "subagent_summary",
        source: "subagent_result",
        priority: 70,
        tokenEstimate: defaultTokenEstimator.estimate(previousSummary),
        createdAt: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
        relevance: 0.9,
        pinned: true,
        compressible: false,
        compressionStrategy: "summary",
        sensitivity: "internal",
        content: previousSummary,
        rawRef: { kind: "other", id: `${input.sessionId}:summary.md` },
        tags: ["session_summary", "previous"],
        metadata: { trigger: input.trigger, summaryFile: "summary.md" },
      });
    }

    const candidateBlockIds = blocks.filter((block) => block.compressible && !block.pinned).map((block) => block.id);
    const protectedBlockIds = blocks.filter((block) => block.pinned || !candidateBlockIds.includes(block.id)).map((block) => block.id);
    const adapter = new CompactionSubAgentRunnerAdapter({
      runner: new LlmCompactionSubAgentRunner({
        gateway: this.modelGateway,
        fallbackRunner: new RuleCompactionSubAgentRunner(),
      }),
      registration: createCompactionSubAgentRegistration(),
    });
    const output = await adapter.compact({
      id: requestId,
      blocks,
      candidateBlockIds,
      protectedBlockIds,
      tokenBudget: 2_400,
      reason: "Generate a lightweight structured summary for summary.md.",
      expectedOutput: "context_blocks",
      instructions: buildSessionSummaryInstructions(input.trigger),
    });
    const markdown = renderSessionSummaryMarkdown({
      trigger: input.trigger,
      summary: output.summary,
      blocks: output.blocks,
      ...(output.fallbackReason ? { fallbackReason: output.fallbackReason } : {}),
    });
    return {
      sessionId: input.sessionId,
      requestId,
      trigger: input.trigger,
      markdown,
      sourceBlockIds: output.sourceBlockIds,
      status: output.fallbackReason ? "fallback" : "succeeded",
    };
  }


  private async recallMemoriesForRequest(req: SessionRequest, currentUserInputText: string): Promise<import("@jue/shared-types").MemoryRecord[]> {
    const text = currentUserInputText.trim();
    if (!text) return [];
    try {
      const result = await this.memoryManager.retrieve({
        text,
        scopes: ["user", "global", "project"],
        limit: 8,
        minScore: 0.18,
        ...(this.runtimeMeta.workspaceRoot ? { workspaceRoot: this.runtimeMeta.workspaceRoot } : {}),
      });
      return result.memories.map((item) => ({
        ...item.record,
        metadata: {
          ...(item.record.metadata ?? {}),
          retrievalScore: item.score,
          retrievalReason: item.reason,
          matchedTerms: item.matchedTerms,
          requiresVerification: item.requiresVerification,
          ageDays: item.ageDays,
        },
      }));
    } catch (err) {
      this.logger.warn({ err }, "memory recall failed");
      return [];
    }
  }
  private buildPromptRuntimeContext(req: SessionRequest): PromptRuntimeContext {
    const ctx: PromptRuntimeContext = {
      sessionId: req.sessionId,
      requestId: req.requestId,
      frontend: req.frontend,
      mode: req.mode,
      enabledToolNames: this.enabledToolNamesForRequest(req),
    };
    if (req.capabilities) {
      ctx.frontendCapabilities = {
        streaming: req.capabilities.streaming,
        markdown: req.capabilities.markdown,
        images: req.capabilities.images,
        files: req.capabilities.files,
        tools: req.capabilities.tools,
        confirmDialog: req.capabilities.confirmDialog,
        notifications: req.capabilities.notifications,
      };
    }
    if (req.flags && Object.keys(req.flags).length > 0) ctx.sessionFlags = req.flags;
    if (this.runtimeMeta.appEnv) ctx.appEnv = this.runtimeMeta.appEnv;
    if (this.runtimeMeta.defaultLanguage) ctx.defaultLanguage = this.runtimeMeta.defaultLanguage;
    if (this.runtimeMeta.defaultTimezone) ctx.defaultTimezone = this.runtimeMeta.defaultTimezone;
    if (this.runtimeMeta.workspaceRoot) ctx.workspaceRoot = this.runtimeMeta.workspaceRoot;
    if (this.runtimeMeta.environment) ctx.environment = this.runtimeMeta.environment;
    if (this.runtimeMeta.availableSkills) ctx.availableSkills = this.runtimeMeta.availableSkills;
    if (!isTeamModeRequest(req) && this.runtimeMeta.availableSubAgents) ctx.availableSubAgents = this.runtimeMeta.availableSubAgents;
    return ctx;
  }

  private persistToolResult(
    req: SessionRequest,
    call: ToolCall,
    result: ToolResult,
    contextContent: string,
    modelContent: string,
  ): EnginePersistedToolResultSummary | undefined {
    if (!this.toolResultRepository) return undefined;
    try {
      const persisted = this.toolResultRepository.persist({
        sessionId: req.sessionId,
        requestId: req.requestId,
        call,
        result,
        contextContent,
        modelContent,
      });
      this.transcriptSink?.appendToolResultPersisted({ sessionId: req.sessionId, requestId: req.requestId, payload: persisted });
      return persisted;
    } catch (err) {
      this.logger.warn({ err, sessionId: req.sessionId, requestId: req.requestId, toolName: call.toolName }, "failed to persist tool result");
      return undefined;
    }
  }

  private buildDurableCompressionPayload(
    req: SessionRequest,
    contextBuild: Awaited<ReturnType<ContextManager["buildForMainAgent"]>>,
    basePayload: Record<string, unknown>,
  ): EngineDurableCompressionPayload | undefined {
    if (!shouldPersistCompression(contextBuild, this.compressionPersistence)) return undefined;
    const persistedBlocks = contextBuild.assembly.blocks.filter(isPersistableCompressedBlock);
    if (persistedBlocks.length === 0) return undefined;
    return {
      compressedBlockIds: idArray(basePayload.compressedBlockIds),
      droppedBlockIds: idArray(basePayload.droppedBlockIds),
      cacheHitKeys: stringArray(basePayload.cacheHitKeys),
      ...(typeof basePayload.pressure === "string" ? { pressure: basePayload.pressure } : {}),
      ...(typeof basePayload.totalTokens === "number" ? { totalTokens: basePayload.totalTokens } : {}),
      ...(typeof basePayload.blockCount === "number" ? { blockCount: basePayload.blockCount } : {}),
      ...(typeof basePayload.strategyVersion === "string" ? { strategyVersion: basePayload.strategyVersion } : {}),
      ...summaryRefsPayload(basePayload.summaryRefs),
      persisted: true,
      persistenceReason: "auto_durable_compact",
      persistedBlocks,
      requestId: req.requestId,
    };
  }

  private makeEvent(
    req: SessionRequest,
    type: StreamEvent["type"],
    payload: unknown,
  ): StreamEvent {
    const ev: StreamEvent = {
      eventId: newId("evt"),
      sessionId: req.sessionId,
      requestId: req.requestId,
      type,
      at: Date.now(),
      payload,
    };
    if (req.trace) ev.trace = req.trace;
    return ev;
  }

  private enabledToolNamesForRequest(req: SessionRequest): string[] {
    const names = this.toolRegistry.enabledNames();
    if (isTeamLeaderRequest(req)) return [];
    if (!isTeamModeRequest(req)) return names;
    const allowed = teamAllowedToolSet(req);
    return names.filter((name) => name !== "subagent.invoke" && (!allowed || allowed.has(name)));
  }
  private buildModelToolDefinitions(req: SessionRequest): ModelToolDefinition[] {
    this.modelToolNameToInternalName.clear();
    if (isTeamLeaderRequest(req)) return [];
    const allowed = teamAllowedToolSet(req);
    return this.toolRegistry.listEnabled().filter((reg) => !isTeamModeRequest(req) || (reg.spec.name !== "subagent.invoke" && (!allowed || allowed.has(reg.spec.name)))).map((reg) => {
      const modelName = toModelToolName(reg.spec.name);
      this.modelToolNameToInternalName.set(modelName, reg.spec.name);
      return {
        type: "function" as const,
        function: {
          name: modelName,
          description: reg.spec.description ?? reg.spec.displayName ?? reg.spec.name,
          parameters: buildModelToolInputSchema((reg.spec.inputSchema ?? {}) as Record<string, unknown>),
        },
      };
    });
  }

  private toInternalToolName(modelToolName: string): string {
    return this.modelToolNameToInternalName.get(modelToolName) ?? modelToolName;
  }
}
export type Engine = AgentEngine;
function isPersistableCompressedBlock(block: ContextBlock): boolean {
  const compressedBy = block.metadata?.compressedBy;
  return compressedBy === "llm_compaction_subagent" || compressedBy === "rule_compaction_subagent";
}

function buildMemoryQueuedPayload(text: string): Record<string, unknown> {
  return {
    action: "queued",
    text: text.slice(0, 240),
    written: [],
    removed: 0,
    rejectedReasons: [],
  };
}


function extractWrittenMemoryRecords(output: unknown): Array<Record<string, unknown>> {
  if (!isPlainRecord(output) || !Array.isArray(output.written)) return [];
  return output.written.filter(isPlainRecord).map((item) => ({ ...item }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildMemoryRecordedPayload(result: Awaited<ReturnType<MemoryManager["extractNow"]>>): Record<string, unknown> {
  return {
    action: result.action,
    text: result.text.slice(0, 240),
    written: result.written.map((record) => ({
      id: record.id,
      scope: record.scope,
      type: typeof record.metadata?.memoryType === "string" ? record.metadata.memoryType : undefined,
      title: record.title,
      summary: record.summary,
      status: record.status,
      writeMode: typeof record.metadata?.writeMode === "string" ? record.metadata.writeMode : "created",
      classificationReason: typeof record.metadata?.classificationReason === "string" ? record.metadata.classificationReason : undefined,
      memoryPath: typeof record.metadata?.memoryPath === "string" ? record.metadata.memoryPath : undefined,
    })),
    removed: result.removed,
    rejectedReasons: result.rejectedReasons,
  };
}

function buildContextBudgetPayload(contextBuild: Awaited<ReturnType<ContextManager["buildForMainAgent"]>>): Record<string, unknown> {
  const budget = contextBuild.assembly.budget;
  const ceilingTokens = budget.hardCeilingTokens ?? Math.max(0, budget.totalTokenBudget - budget.reservedForResponse);
  const usedTokens = contextBuild.assembly.totalTokens;
  const remainingTokens = Math.max(0, ceilingTokens - usedTokens);
  const remainingRatio = ceilingTokens > 0 ? remainingTokens / ceilingTokens : 0;
  return {
    usedTokens,
    ceilingTokens,
    remainingTokens,
    remainingRatio,
    pressure: contextBuild.pressure,
    compressedBlockCount: contextBuild.compressedBlockIds.length,
    droppedBlockCount: contextBuild.assembly.droppedBlockIds.length,
  };
}

function hasContextCompaction(contextBuild: Awaited<ReturnType<ContextManager["buildForMainAgent"]>>): boolean {
  return contextBuild.compressedBlockIds.length > 0 || contextBuild.assembly.droppedBlockIds.length > 0;
}

function renderMessagesForSessionSummary(messages: Message[]): string {
  return [...messages]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((message, index) => {
      const parts = message.parts.map(renderMessagePartForSummary).filter(Boolean).join("\n");
      return [`[${index + 1}] role=${message.role} id=${message.id} at=${new Date(message.createdAt).toISOString()}`, parts].join("\n");
    })
    .join("\n\n---\n\n");
}

function renderMessagePartForSummary(part: MessagePart): string {
  if (part.type === "text") return part.text;
  if (part.type === "image") return `[image mimeType=${part.mimeType}]`;
  if (part.type === "file") return `[file name=${part.name ?? ""} path=${part.path ?? ""} url=${part.url ?? ""} mimeType=${part.mimeType}]`;
  if (part.type === "tool_call") return `[tool_call name=${part.toolName} callId=${part.callId}]\n${part.arguments}`;
  if (part.type === "tool_result") return `[tool_result name=${part.toolName} callId=${part.callId} error=${part.isError === true}]\n${part.content}`;
  return "";
}

function buildSessionSummaryInstructions(trigger: SessionSummaryInput["trigger"]): string[] {
  return [
    `session_summary trigger=${trigger}`,
    "Use a lightweight structured summary for summary.md.",
    "Keep the output concise and stable.",
  ];
}


function renderSessionSummaryMarkdown(input: {
  trigger: SessionSummaryInput["trigger"];
  summary: string;
  blocks: ContextBlock[];
  fallbackReason?: string | undefined;
}): string {
  const body = input.blocks
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const overview = input.summary.trim() || body.trim() || "无摘要。";
  const fileNotes = body.slice(0, 600) || "无。";
  return [
    `## 会话摘要 ${new Date().toISOString()}`,
    "",
    `- trigger: ${input.trigger}`,
    ...(input.fallbackReason ? [`- fallbackReason: ${input.fallbackReason}`] : []),
    "",
    "### 概览",
    overview,
    "",
    "### 关键上下文",
    fileNotes,
    "",
    "### 后续任务",
    "无。",
    "",
    "### 风险",
    "无。",
    "",
    "### 记忆候选",
    "无。",
  ].join("\n").trim();
}

function shouldPersistCompression(
  contextBuild: Awaited<ReturnType<ContextManager["buildForMainAgent"]>>,
  policy: EngineCompressionPersistencePolicy,
): boolean {
  if (policy.autoPersist !== true) return false;
  const levels = policy.pressureLevels ?? ["overflow"];
  return levels.includes(contextBuild.pressure as "llm_compress" | "overflow");
}

function idArray(value: unknown): Id[] {
  return Array.isArray(value) ? value.filter((item): item is Id => typeof item === "string") : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function summaryRefsPayload(value: unknown): { summaryRefs?: Array<{ blockId: Id; summaryRef: Id }> } {
  if (!Array.isArray(value)) return {};
  const summaryRefs = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.blockId === "string" && typeof record.summaryRef === "string"
      ? [{ blockId: record.blockId, summaryRef: record.summaryRef }]
      : [];
  });
  return summaryRefs.length > 0 ? { summaryRefs } : {};
}

function buildContextCompressedPayload(contextBuild: Awaited<ReturnType<ContextManager["buildForMainAgent"]>>): Record<string, unknown> {
  return {
    pressure: contextBuild.pressure,
    totalTokens: contextBuild.assembly.totalTokens,
    blockCount: contextBuild.assembly.blocks.length,
    compressedBlockIds: contextBuild.compressedBlockIds,
    droppedBlockIds: contextBuild.assembly.droppedBlockIds,
    cacheHitKeys: contextBuild.cacheHitKeys,
    strategyVersion: contextBuild.assembly.strategyVersion,
    summaryRefs: contextBuild.assembly.blocks
      .filter((block) => block.summaryRef)
      .map((block) => ({ blockId: block.id, summaryRef: block.summaryRef })),
  };
}

function mergeUsage(
  acc: SessionUsage,
  chunkUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined,
): void {
  if (!chunkUsage) return;
  acc.promptTokens += chunkUsage.promptTokens ?? 0;
  acc.completionTokens += chunkUsage.completionTokens ?? 0;
  acc.totalTokens += chunkUsage.totalTokens ?? 0;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __raw: raw };
  }
}

function parseToolCallArguments(raw: string): { arguments: Record<string, unknown>; relevanceScore: number; metadata: Record<string, unknown> } {
  const parsed = parseToolArguments(raw);
  const relevanceScore = clampRelevanceScore(parsed.relevanceScore);
  const { relevanceScore: _relevanceScore, ...toolArguments } = parsed;
  return {
    arguments: toolArguments,
    relevanceScore,
    metadata: { relevanceScore },
  };
}

function clampRelevanceScore(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function toModelToolName(internalName: string): string {
  return internalName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function withRequiredRelevanceScore(schema: Record<string, unknown>): Record<string, unknown> {
  const objectSchema = schema.type === "object" ? schema : { type: "object", properties: {} };
  const properties = typeof objectSchema.properties === "object" && objectSchema.properties !== null
    ? objectSchema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(objectSchema.required) ? objectSchema.required.filter((item): item is string => typeof item === "string") : [];
  return {
    ...objectSchema,
    properties: {
      ...properties,
      relevanceScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Required: estimate how relevant this tool result will be to the current task. 0 = unrelated, 1 = highly relevant.",
      },
    },
    required: Array.from(new Set([...required, "relevanceScore"])),
  };
}

function buildModelToolInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeSchemaForModelTools(withRequiredRelevanceScore(schema));
  return isPlainRecord(sanitized) ? sanitized : { type: "object", properties: {}, required: [] };
}

function sanitizeSchemaForModelTools(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeSchemaForModelTools(item));
  if (!isPlainRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "default") continue;
    if (key === "required" && Array.isArray(child)) {
      const properties = isPlainRecord(value.properties) ? value.properties : {};
      out.required = child.filter((item): item is string => typeof item === "string" && item in properties);
      continue;
    }
    out[key] = sanitizeSchemaForModelTools(child);
  }

  if (out.type !== "object") return out;
  if (!isPlainRecord(out.properties)) out.properties = {};
  if (!Array.isArray(out.required)) out.required = [];
  return out;
}


function buildObservationHints(result: Awaited<ReturnType<MemoryManager["observeUserMessage"]>> | undefined, hypotheses: string[]): string[] {
  const hints: string[] = [];
  const promoted = result?.candidates
    .map((candidate) => candidate.summary ?? candidate.title ?? candidate.content)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0) ?? [];
  hints.push(...promoted.map((item) => `观察池已升级为正式记忆候选: ${item.slice(0, 160)}`));
  hints.push(...hypotheses);
  return Array.from(new Set(hints)).slice(0, 4);
}

function renderTaskState(mode: string, notifications: SubAgentNotification[], memoryObservationHints: string[] = []): string {
  const lines = [`mode=${mode}`];
  if (notifications.length > 0) {
    lines.push("Pending subagent completion notifications:");
    for (const item of notifications) {
      lines.push(`- ${item.subagentName} task=${item.taskId} status=${item.status}: ${item.conclusion}`);
    }
  }
  if (memoryObservationHints.length > 0) {
    lines.push("Memory observation hints:");
    for (const hint of memoryObservationHints) lines.push(`- ${hint}`);
  }
  return lines.join("\n");
}
function denyToolResult(call: ToolCall, reason: string): ToolResult {
  const now = Date.now();
  return {
    id: newId("tres"),
    callId: call.id,
    toolName: call.toolName,
    status: "rejected",
    relevanceScore: call.relevanceScore,
    tokenEstimate: 0,
    durationMs: 0,
    error: { code: "POLICY_DENIED", message: reason, retriable: false },
    startedAt: now,
    finishedAt: now,
    truncated: false,
  };
}

function serializeToolResultForModel(result: ToolResult): { content: string; isError: boolean } {
  if (result.status === "succeeded") {
    const text = stringifyOutput(result.output);
    if (text.length > 8 * 1024) {
      return {
        content: result.summary ?? (text.slice(0, 8 * 1024) + "\\n[truncated]"),
        isError: false,
      };
    }
    return { content: text, isError: false };
  }
  const payload = {
    error: result.error?.code ?? "TOOL_FAILED",
    message: result.error?.message ?? "tool execution failed",
    status: result.status,
  };
  return { content: JSON.stringify(payload), isError: true };
}

function serializeToolResultForContext(result: ToolResult): string {
  if (result.status !== "succeeded") {
    return JSON.stringify({ status: result.status, error: result.error });
  }
  return result.summary ?? stringifyOutput(result.output);
}

function inferToolResultKind(toolName: string): "tool" | "shell" {
  return /shell|exec|run|powershell|bash|cmd/i.test(toolName) ? "shell" : "tool";
}

function previewDebugContent(content: string): string {
  const oneLine = content.replace(/\\s+/g, " ").trim();
  return oneLine.length > 160 ? oneLine.slice(0, 160) + "..." : oneLine;
}

function stringifyOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}


function messageText(message: Message): string {
  return message.parts.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function isExplicitMemoryRequest(text: string): boolean {
  return /(?:\u8bb0\u4f4f|\u8bf7\u8bb0\u4f4f|\u5e2e\u6211\u8bb0\u4f4f|\u4ee5\u540e\u8bb0\u5f97|\u5fd8\u6389|\u5220\u9664\u8bb0\u5fc6|\u4e0d\u8981\u518d\u8bb0|remember|forget)/i.test(text);
}
function isTeamModeRequest(req: SessionRequest): boolean {
  return req.flags?.teamMode === true;
}

function isTeamLeaderRequest(req: SessionRequest): boolean {
  return isTeamModeRequest(req) && req.flags?.teamRole === "leader";
}

function teamAllowedToolSet(req: SessionRequest): Set<string> | undefined {
  const raw = req.flags?.teamAllowedTools;
  if (typeof raw !== "string") return undefined;
  const names = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return names.length > 0 ? new Set(names) : new Set<string>();
}








