/**
 * @file repository.ts
 * @module @jue/memory/repository
 *
 * 闀挎湡璁板繂浠撳簱銆傛枃浠跺疄鐜颁娇鐢ㄧ粨鏋勫寲 Markdown锛氭瘡涓蹇嗙洰褰曞寘鍚竴涓?MEMORY.md
 * 绱㈠紩鍜岃嫢骞茬粏鑺傛枃浠躲€傚啓鍏ャ€佸垹闄ゅ拰缁存姢閮藉繀椤诲悓姝ョ储寮曚笌鏈綋銆?
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  MemoryDocument,
  MemoryDocumentType,
  MemoryFrontmatter,
  MemoryIndexEntry,
  MemoryKind,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  MemoryWriteRequest,
} from "@jue/shared-types";
import { MemoryFrontmatterSchema, MemoryRecordSchema } from "@jue/shared-types";
import { newId } from "@jue/utils";

const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const INDEX_MAX_LINES = 200;
const MEMORY_ROOT_DIR = "memory";
const DREAM_EVENTS_FILE = "dream-events.jsonl";

type MemoryRecordDraft = Partial<MemoryRecord> & Record<string, unknown>;

export interface MemoryRepository {
  query(q: MemoryQuery): Promise<MemoryRecord[]>;
  write(req: MemoryWriteRequest): Promise<MemoryRecord[]>;
  remove(id: string): Promise<void>;
  listDocuments?(q?: MemoryQuery): Promise<MemoryDocument[]>;
  removeByName?(input: { name: string; scope?: MemoryScope; workspaceRoot?: string }): Promise<boolean>;
  mergeDocuments?(input: { keepName: string; removeNames: string[]; reason?: string; mergedDescription?: string; mergedBody?: string; tags?: string[]; workspaceRoot?: string }): Promise<boolean>;
  rewriteIndexes?(): Promise<number>;
}

export interface FileMemoryRepositoryOptions {
  globalJueDir: string;
  workspaceRoot?: string;
  defaultUserId?: string;
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly bucket = new Map<string, MemoryRecord>();

  async query(q: MemoryQuery): Promise<MemoryRecord[]> {
    const now = Date.now();
    return [...this.bucket.values()]
      .filter((record) => matchesRecord(record, q, now))
      .sort(sortRecords)
      .slice(0, q.limit ?? 20);
  }

  async write(req: MemoryWriteRequest): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const input of req.records) {
      const normalized = normalizeRecord(input as MemoryRecordDraft, req, { ownerId: String(input.ownerId ?? "local-user") });
      this.bucket.set(normalized.id, normalized);
      out.push(normalized);
    }
    return out;
  }

  async remove(id: string): Promise<void> {
    this.bucket.delete(id);
  }
}

export class FileMemoryRepository implements MemoryRepository {
  readonly globalJueDir: string;
  private readonly workspaceRoot: string | undefined;
  private readonly defaultUserId: string;

  constructor(options: FileMemoryRepositoryOptions) {
    this.globalJueDir = resolve(options.globalJueDir);
    this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
    this.defaultUserId = options.defaultUserId ?? "local-user";
    ensureDir(this.globalJueDir);
    if (this.workspaceRoot) migrateLegacyProjectMemoryDir(this.globalJueDir, this.workspaceRoot);
  }

  async query(q: MemoryQuery): Promise<MemoryRecord[]> {
    const now = Date.now();
    const docs = await this.listDocuments(q);
    return docs
      .map((doc) => documentToRecord(doc, this.defaultUserId))
      .filter((record) => matchesRecord(record, q, now))
      .sort(sortRecords)
      .slice(0, q.limit ?? 20)
      .map((record) => withAgeReminder(record, now));
  }

  async write(req: MemoryWriteRequest): Promise<MemoryRecord[]> {
    const written: MemoryRecord[] = [];
    for (const input of req.records) {
      const normalized = normalizeRecord(input as MemoryRecordDraft, req, { ownerId: String(input.ownerId ?? this.defaultUserId) });
      if (isForbiddenMemory(normalized)) continue;

      const type = recordToDocumentType(normalized);
      const scope = scopeForDocumentType(type, normalizeScope(normalized.scope));
      const dir = this.resolveMemoryDir(scope, req.workspaceRoot);
      ensureMemoryDir(dir);

      const existing = findMergeTarget(dir, type, normalized);
      const memoryName = existing?.frontmatter.name ?? nextAvailableMemoryName(dir, type, slugify(normalized.title));
      const frontmatter = MemoryFrontmatterSchema.parse({
        name: memoryName,
        description: mergeDescription(existing?.frontmatter.description, normalized.summary ?? firstSentence(normalized.content)),
        type,
        scope,
        originSessionId: normalized.originSessionId ?? req.sessionId ?? "unknown-session",
        ttlMs: normalized.ttlMs ?? DEFAULT_TTL_MS,
        weight: Math.max(normalized.weight, existing?.frontmatter.weight ?? 0),
        sensitivity: normalized.sensitivity,
        provenance: normalized.provenance,
        status: resolveStoredStatus(normalized, req.source),
        createdAt: existing?.frontmatter.createdAt ?? normalized.createdAt,
        updatedAt: normalized.updatedAt ?? Date.now(),
        expiresAt: normalized.expiresAt ?? normalized.createdAt + (normalized.ttlMs ?? DEFAULT_TTL_MS),
        tags: mergeTags(existing?.frontmatter.tags ?? [], normalized.tags),
      });
      const filePath = join(dir, `${type}_${frontmatter.name}.md`);
      writeFileSync(filePath, renderMemoryDocument(frontmatter, mergeBody(existing?.body, normalizeBodyForType(normalized.content, type))), "utf8");
      this.appendDreamMemoryEvent({
        ...(req.workspaceRoot ? { workspaceRoot: req.workspaceRoot } : {}),
        sessionId: normalized.originSessionId ?? req.sessionId ?? "unknown-session",
        memoryName: frontmatter.name,
        scope,
        type,
        writeMode: existing ? "merged" : "created",
        at: frontmatter.updatedAt ?? Date.now(),
      });
      rewriteIndex(dir);
      written.push(documentToRecord(readMemoryDocument(filePath), this.defaultUserId, {
        ...(normalized.metadata ?? {}),
        writeMode: existing ? "merged" : "created",
        classificationReason: explainMemoryClassification(type, scope),
        ...(existing ? { mergedFrom: existing.path } : {}),
      }));
    }
    return written;
  }

  async remove(id: string): Promise<void> {
    for (const doc of await this.listDocuments()) {
      if (doc.id !== id && doc.frontmatter.name !== id) continue;
      rmSync(doc.path, { force: true });
      rewriteIndex(dirname(doc.path));
    }
  }

  async removeByName(input: { name: string; scope?: MemoryScope; workspaceRoot?: string }): Promise<boolean> {
    const target = slugify(input.name);
    let removed = false;
    for (const doc of await this.listDocuments({
      kinds: [],
      tags: [],
      documentTypes: [],
      scopes: [],
      includeIndexOnly: false,
      limit: 200,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    })) {
      if (doc.frontmatter.name !== target && doc.frontmatter.name !== input.name) continue;
      rmSync(doc.path, { force: true });
      rewriteIndex(dirname(doc.path));
      removed = true;
    }
    return removed;
  }

  async mergeDocuments(input: { keepName: string; removeNames: string[]; reason?: string; mergedDescription?: string; mergedBody?: string; tags?: string[]; workspaceRoot?: string }): Promise<boolean> {
    const docs = await this.listDocuments({
      scopes: ["user", "global", "project"],
      kinds: [],
      tags: [],
      documentTypes: [],
      includeIndexOnly: false,
      limit: 200,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    });
    const keep = docs.find((doc) => doc.frontmatter.name === input.keepName);
    if (!keep) return false;
    const removeSet = new Set(input.removeNames.filter((name) => name !== input.keepName));
    const removing = docs.filter((doc) => removeSet.has(doc.frontmatter.name));
    if (removeSet.size === 0 || removing.length !== removeSet.size) return false;

    const mergedFrontmatter = MemoryFrontmatterSchema.parse({
      ...keep.frontmatter,
      description: input.mergedDescription ?? mergeDescription(keep.frontmatter.description, removing.map((doc) => doc.frontmatter.description).join(" ")),
      weight: Math.max(keep.frontmatter.weight, ...removing.map((doc) => doc.frontmatter.weight), 0),
      updatedAt: Date.now(),
      tags: mergeTags(mergeTags(keep.frontmatter.tags, removing.flatMap((doc) => doc.frontmatter.tags)), input.tags ?? []),
    });
    const mergedBody = input.mergedBody?.trim() || mergeBodies([keep.body, ...removing.map((doc) => doc.body)], input.reason);
    writeFileSync(keep.path, renderMemoryDocument(mergedFrontmatter, mergedBody), "utf8");
    for (const doc of removing) rmSync(doc.path, { force: true });
    if (removing.some((doc) => existsSync(doc.path))) return false;
    rewriteIndex(dirname(keep.path));
    for (const doc of removing) {
      const dir = dirname(doc.path);
      if (dir !== dirname(keep.path)) rewriteIndex(dir);
    }
    return true;
  }

  async rewriteIndexes(): Promise<number> {
    let count = 0;
    for (const dir of this.resolveCandidateDirs(defaultQuery())) {
      ensureMemoryDir(dir);
      rewriteIndex(dir);
      count += 1;
    }
    return count;
  }

  async listDocuments(q: MemoryQuery = defaultQuery()): Promise<MemoryDocument[]> {
    const docs: MemoryDocument[] = [];
    for (const dir of this.resolveCandidateDirs(q)) {
      ensureMemoryDir(dir);
      for (const filePath of listMarkdownFiles(dir)) {
        if (basename(filePath).toLowerCase() === "memory.md") continue;
        const doc = safeReadMemoryDocument(filePath);
        if (!doc) continue;
        if (!matchesDocument(doc, q)) continue;
        docs.push(doc);
      }
      rewriteIndex(dir);
    }
    return docs
      .sort((a, b) => (b.frontmatter.weight - a.frontmatter.weight) || ((b.frontmatter.updatedAt ?? b.frontmatter.createdAt) - (a.frontmatter.updatedAt ?? a.frontmatter.createdAt)))
      .slice(0, q.limit ?? 200);
  }

  private resolveCandidateDirs(q: MemoryQuery): string[] {
    const scopes = queryArray(q.scopes).length > 0 ? queryArray(q.scopes) : q.scope ? [q.scope] : ["user", "global", "project"] as MemoryScope[];
    return Array.from(new Set(scopes.map((scope) => this.resolveMemoryDir(normalizeScope(scope), q.workspaceRoot))));
  }

  private appendDreamMemoryEvent(input: { workspaceRoot?: string; sessionId: string; memoryName: string; scope: MemoryScope; type: MemoryDocumentType; writeMode: "created" | "merged"; at: number }): void {
    const root = input.workspaceRoot ?? this.workspaceRoot;
    if (!root || input.sessionId === "unknown-session") return;
    const dir = join(this.globalJueDir, "projects", workspacePathSlug(root), MEMORY_ROOT_DIR);
    ensureMemoryDir(dir);
    const event = {
      version: 1,
      at: input.at,
      sessionId: input.sessionId,
      memoryName: input.memoryName,
      scope: input.scope,
      type: input.type,
      writeMode: input.writeMode,
    };
    writeFileSync(join(dir, DREAM_EVENTS_FILE), `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  private resolveMemoryDir(scope: MemoryScope, workspaceRoot?: string): string {
    if (scope === "project") {
      const root = workspaceRoot ?? this.workspaceRoot ?? process.cwd();
      return join(this.globalJueDir, "projects", workspacePathSlug(root), MEMORY_ROOT_DIR);
    }
    if (scope === "global") return join(this.globalJueDir, "global", MEMORY_ROOT_DIR);
    if (scope === "team") return join(this.globalJueDir, "team", MEMORY_ROOT_DIR);
    return join(this.globalJueDir, "user", MEMORY_ROOT_DIR);
  }
}

function normalizeRecord(input: MemoryRecordDraft, req: MemoryWriteRequest, defaults: { ownerId: string }): MemoryRecord {
  const now = Date.now();
  const content = String(input.content ?? "").trim();
  const title = String(input.title ?? firstSentence(content)).trim() || "memory";
  const ttlMs = typeof input.ttlMs === "number" ? input.ttlMs : DEFAULT_TTL_MS;
  return MemoryRecordSchema.parse({
    id: input.id ?? newId("mem"),
    scope: normalizeScope((input.scope as MemoryScope | undefined) ?? inferScope(input)),
    ownerId: input.ownerId ?? defaults.ownerId,
    kind: (input.kind as MemoryKind | undefined) ?? inferKind(input),
    origin: input.origin ?? req.source,
    status: input.status ?? (req.source === "explicit_user" ? "active" : "candidate"),
    title,
    content,
    summary: input.summary ?? firstSentence(content),
    weight: input.weight ?? (req.source === "explicit_user" ? 0.85 : 0.55),
    confidence: input.confidence ?? (req.source === "explicit_user" ? 0.9 : 0.65),
    sensitivity: input.sensitivity ?? "internal",
    provenance: input.provenance ?? provenanceFor(input.origin ?? req.source),
    tags: input.tags ?? [],
    sourceMessageIds: input.sourceMessageIds ?? [],
    sourceToolResultIds: input.sourceToolResultIds ?? [],
    ttlMs,
    expiresAt: input.expiresAt ?? now + ttlMs,
    originSessionId: input.originSessionId ?? req.sessionId ?? "unknown-session",
    ...(input.sharing ? { sharing: input.sharing } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    lastAccessedAt: input.lastAccessedAt,
    accessCount: input.accessCount ?? 0,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

function provenanceFor(origin: MemoryWriteRequest["source"] | MemoryRecord["origin"]): MemoryRecord["provenance"] {
  if (origin === "explicit_user") return "explicit";
  if (origin === "auto_extracted" || origin === "subagent") return "inferred";
  return "inferred";
}

function resolveStoredStatus(record: MemoryRecord, source: MemoryWriteRequest["source"]): MemoryRecord["status"] {
  if (source === "explicit_user") return "active";
  if (record.status !== "candidate") return record.status;

  // 鑷姩鎻愬彇缁忚繃 pipeline/LLM 鏍￠獙鍚庯紝濡傛灉缃俊搴﹁冻澶熼珮锛屽簲杩涘叆鍙彫鍥為暱鏈熻蹇嗐€?  // 鍚﹀垯鏂囦欢铏界劧钀界洏锛屼絾 MemoryRetriever 鍙 active锛屽疄闄呭鍚庣画瀵硅瘽涓嶈捣浣滅敤銆?  if (record.provenance === "observed") return record.confidence >= 0.5 && record.weight >= 0.4 ? "active" : "candidate";
  if (source === "auto_extracted" && record.confidence >= 0.68 && record.weight >= 0.55) return "active";
  return "candidate";
}

function documentToRecord(doc: MemoryDocument, ownerId: string, extraMetadata: Record<string, unknown> = {}): MemoryRecord {
  const fm = doc.frontmatter;
  return MemoryRecordSchema.parse({
    id: fm.name,
    scope: fm.scope,
    ownerId,
    kind: documentTypeToKind(fm.type),
    origin: "import",
    provenance: fm.provenance,
    status: fm.status,
    title: memoryRecordTitle(fm),
    content: doc.body,
    summary: fm.description,
    weight: fm.weight,
    confidence: 0.85,
    sensitivity: fm.sensitivity,
    tags: fm.tags,
    sourceMessageIds: [],
    sourceToolResultIds: [],
    ttlMs: fm.ttlMs,
    ...(fm.expiresAt ? { expiresAt: fm.expiresAt } : {}),
    originSessionId: fm.originSessionId,
    createdAt: fm.createdAt,
    ...(fm.updatedAt ? { updatedAt: fm.updatedAt } : {}),
    accessCount: 0,
    metadata: {
      memoryPath: doc.path,
      memoryName: fm.name,
      memoryType: fm.type,
      indexLine: doc.indexLine,
      ...extraMetadata,
    },
  });
}

function defaultQuery(): MemoryQuery {
  return { kinds: [], tags: [], documentTypes: [], scopes: [], includeIndexOnly: false, limit: 200 };
}

function queryArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function matchesDocument(doc: MemoryDocument, q: MemoryQuery): boolean {
  const documentTypes = queryArray(q.documentTypes);
  const tags = queryArray(q.tags);
  if (q.status && doc.frontmatter.status !== q.status) return false;
  if (documentTypes.length > 0 && !documentTypes.includes(doc.frontmatter.type)) return false;
  if (tags.length > 0 && !tags.some((tag) => doc.frontmatter.tags.includes(tag))) return false;
  if (q.minWeight !== undefined && doc.frontmatter.weight < q.minWeight) return false;
  if (q.text && !matchesText(doc, q.text)) return false;
  return true;
}

function matchesRecord(record: MemoryRecord, q: MemoryQuery, now: number): boolean {
  const scopes = queryArray(q.scopes);
  const kinds = queryArray(q.kinds);
  const tags = queryArray(q.tags);
  if (record.expiresAt && record.expiresAt <= now) return false;
  if (q.scope && record.scope !== q.scope) return false;
  if (scopes.length > 0 && !scopes.includes(record.scope)) return false;
  if (q.ownerId && record.ownerId !== q.ownerId) return false;
  if (kinds.length > 0 && !kinds.includes(record.kind)) return false;
  if (tags.length > 0 && !tags.some((tag) => record.tags.includes(tag))) return false;
  if (q.minWeight !== undefined && record.weight < q.minWeight) return false;
  if (q.minConfidence !== undefined && record.confidence < q.minConfidence) return false;
  if (q.status && record.status !== q.status) return false;
  if (q.text) {
    const haystack = `${record.title}\n${record.summary ?? ""}\n${record.content}\n${record.tags.join(" ")}`.toLowerCase();
    if (keywordScore(haystack, q.text.toLowerCase()) <= 0) return false;
  }
  return true;
}

function sortRecords(a: MemoryRecord, b: MemoryRecord): number {
  return (b.weight - a.weight) || (b.confidence - a.confidence) || ((b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
}

function withAgeReminder(record: MemoryRecord, now: number): MemoryRecord {
  const ageDays = Math.floor((now - record.createdAt) / (24 * 60 * 60 * 1000));
  if (ageDays < 14) return record;
  return {
    ...record,
    content: `<system-reminder>This memory is ${ageDays} days old. Memories are point-in-time observations, not live state. Verify code/file/path claims against current project state before asserting them as fact.</system-reminder>\n\n${record.content}`,
  };
}

function readMemoryDocument(filePath: string): MemoryDocument {
  const raw = readFileSync(filePath, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`invalid memory document: ${filePath}`);
  const frontmatter = MemoryFrontmatterSchema.parse(parseFrontmatter(match[1] ?? ""));
  const body = (match[2] ?? "").trim();
  return {
    id: frontmatter.name,
    path: filePath,
    frontmatter,
    body,
    indexLine: renderIndexLine({
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type,
      scope: frontmatter.scope,
      relativePath: basename(filePath),
      weight: frontmatter.weight,
      ...(frontmatter.updatedAt ? { updatedAt: frontmatter.updatedAt } : {}),
      tags: frontmatter.tags,
    }),
  };
}

function safeReadMemoryDocument(filePath: string): MemoryDocument | undefined {
  try {
    return readMemoryDocument(filePath);
  } catch {
    return undefined;
  }
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const raw = line.slice(index + 1).trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      out[key] = raw.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (/^\d+(\.\d+)?$/.test(raw)) {
      out[key] = Number(raw);
    } else {
      out[key] = unquote(raw);
    }
  }
  return out;
}

function renderMemoryDocument(frontmatter: MemoryFrontmatter, body: string): string {
  const lines = [
    "---",`name: ${frontmatter.name}`,
    `description: ${quote(frontmatter.description)}`,
    `type: ${frontmatter.type}`,
    `scope: ${frontmatter.scope}`,
    `originSessionId: ${frontmatter.originSessionId}`,
    `ttlMs: ${frontmatter.ttlMs}`,
    `weight: ${frontmatter.weight}`,
    `sensitivity: ${frontmatter.sensitivity}`,
    `provenance: ${frontmatter.provenance}`,
    `status: ${frontmatter.status}`,
    `createdAt: ${frontmatter.createdAt}`,
    ...(frontmatter.updatedAt ? [`updatedAt: ${frontmatter.updatedAt}`] : []),
    ...(frontmatter.expiresAt ? [`expiresAt: ${frontmatter.expiresAt}`] : []),
    `tags: [${frontmatter.tags.join(", ")}]`,
    "---",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

function rewriteIndex(dir: string): void {
  ensureMemoryDir(dir);
  const docs = listMarkdownFiles(dir)
    .filter((filePath) => basename(filePath).toLowerCase() !== "memory.md")
    .map(safeReadMemoryDocument)
    .filter((doc): doc is MemoryDocument => Boolean(doc))
    .sort((a, b) => (b.frontmatter.weight - a.frontmatter.weight) || ((b.frontmatter.updatedAt ?? b.frontmatter.createdAt) - (a.frontmatter.updatedAt ?? a.frontmatter.createdAt)));
  const maxEntries = Math.max(0, Math.floor((INDEX_MAX_LINES - 5) / 2));
  const lines = [
    "# MEMORY",
    "",
    "本文件是长期记忆索引，只保留紧凑入口。读取相关索引后，再读取对应细节文件。",
    "",
    ...docs.slice(0, maxEntries).map((doc) => doc.indexLine),
    "",
  ];
  writeFileSync(join(dir, "MEMORY.md"), lines.join("\n"), "utf8");
}

function renderIndexLine(entry: MemoryIndexEntry): string {
  const tags = entry.tags.length > 0 ? entry.tags.join(",") : "none";
  const updated = entry.updatedAt ? new Date(entry.updatedAt).toISOString() : "unknown";
  const title = entry.description.trim().slice(0, 40) || titleFromName(entry.name);
  return `- [${title}](${entry.relativePath}) | type=${entry.type} | scope=${entry.scope} | weight=${entry.weight.toFixed(2)} | updated=${updated} | tags=${tags}\n  ${entry.description}`;
}

function ensureMemoryDir(dir: string): void {
  ensureDir(dir);
  const index = join(dir, "MEMORY.md");
  if (!existsSync(index)) {
    writeFileSync(index, "# MEMORY\\n\\n本文件是长期记忆索引，只保留紧凑入口。读取相关索引后，再读取对应细节文件。\\n", "utf8");
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((filePath) => statSync(filePath).isFile() && filePath.toLowerCase().endsWith(".md"));
}

function normalizeScope(scope: MemoryScope): MemoryScope {
  return scope === "working" || scope === "conversation" ? "project" : scope;
}

function inferScope(input: MemoryRecordDraft): MemoryScope {
  if (input.metadata && typeof input.metadata === "object" && (input.metadata as Record<string, unknown>).projectRelated === true) return "project";
  return "user";
}

function inferKind(input: MemoryRecordDraft): MemoryKind {
  if (input.kind) return input.kind as MemoryKind;
  const type = input.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>).memoryDocumentType : undefined;
  if (type === "feedback") return "rule";
  if (type === "reference") return "fact";
  return "preference";
}

function recordToDocumentType(record: MemoryRecord): MemoryDocumentType {
  const type = record.metadata?.memoryDocumentType;
  if (type === "user" || type === "global" || type === "feedback" || type === "project" || type === "reference") return type;
  if (record.scope === "global") return "global";
  if (record.kind === "rule" && record.scope === "project") return "feedback";
  if (record.tags.includes("reference")) return "reference";
  if (record.scope === "project") return "project";
  return "user";
}

function scopeForDocumentType(type: MemoryDocumentType, requestedScope: MemoryScope): MemoryScope {
  if (type === "feedback" || type === "project" || type === "reference") return "project";
  if (type === "global") return "global";
  if (type === "user") return "user";
  return requestedScope;
}
function explainMemoryClassification(type: MemoryDocumentType, scope: MemoryScope): string {
  if (type === "user") return "用户画像、兴趣、长期目标或个人偏好，保存为用户级记忆。";
  if (type === "global") return "跨项目成立的协作偏好、环境约束或通用流程，保存为全局记忆。";
  if (type === "feedback") return "针对 Agent 行为的纠正或确认，保存为当前项目反馈记忆。";
  if (type === "reference") return "外部系统、链接或资料指针，保存为当前项目引用记忆。";
  if (scope === "project") return "只对当前项目成立的决策原因、非代码状态或约束，保存为项目记忆。";
  return "根据记忆类型和作用域规则分类。";
}

function findMergeTarget(dir: string, type: MemoryDocumentType, record: MemoryRecord): MemoryDocument | undefined {
  const wanted = canonicalMemoryText(record.summary ?? record.content);
  const docs = listMarkdownFiles(dir)
    .filter((filePath) => basename(filePath).toLowerCase() !== "memory.md")
    .map(safeReadMemoryDocument)
    .filter((doc): doc is MemoryDocument => Boolean(doc))
    .filter((doc) => doc.frontmatter.type === type && doc.frontmatter.scope === scopeForDocumentType(type, record.scope));
  return docs.find((doc) => canonicalMemoryText(doc.frontmatter.description) === wanted && canonicalMemoryText(doc.body) === canonicalMemoryText(record.content));
}

function mergeDescription(previous: string | undefined, next: string): string {
  if (!previous) return next;
  if (previous.includes(next)) return previous;
  if (next.includes(previous)) return next;
  return next.length >= previous.length ? next : previous;
}

function mergeBody(previous: string | undefined, next: string): string {
  if (!previous?.trim()) return next;
  if (previous.includes(next)) return previous;
  if (next.includes(previous)) return next;
  return previous.trim() + "\n\n" + next.trim();
}

function mergeTags(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right].filter(Boolean))).slice(0, 24);
}

function mergeBodies(parts: string[], reason?: string): string {
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (out.some((existing) => existing.includes(trimmed) || trimmed.includes(existing))) continue;
    out.push(trimmed);
  }
  if (reason) out.push(`**Merge reason:** ${reason}`);
  return out.join("\n\n");
}

function canonicalMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  const normalized = canonicalMemoryText(text);
  const tokens = normalized.split(/[^a-z0-9_\-\p{Script=Han}]+/u).filter((item) => item.length >= 2);
  return new Set(tokens);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
function semanticOverlap(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  const lexical = jaccard(leftTokens, rightTokens);
  const leftText = canonicalMemoryText(left);
  const rightText = canonicalMemoryText(right);
  if (leftText.includes(rightText) || rightText.includes(leftText)) return Math.max(lexical, 0.9);
  return lexical;
}

function memoryRecordTitle(frontmatter: MemoryFrontmatter): string {
  const description = frontmatter.description.replace(/\s+/g, " ").trim();
  if (description) return description.slice(0, 40);
  return titleFromName(frontmatter.name);
}

function documentTypeToKind(type: MemoryDocumentType): MemoryKind {
  if (type === "feedback") return "rule";
  if (type === "project" || type === "reference") return "fact";
  return "preference";
}

function normalizeBodyForType(content: string, type: MemoryDocumentType): string {
  const trimmed = content.trim();
  if ((type === "feedback" || type === "project") && !/\*\*Why:\*\*/i.test(trimmed)) {
    return `${trimmed}\n\n**Why:** 未记录具体原因。\n\n**How to apply:** 仅在与该记忆描述高度相关的场景中启用。`;
  }
  return trimmed;
}

function isForbiddenMemory(record: MemoryRecord): boolean {
  const text = `${record.title}\n${record.summary ?? ""}\n${record.content}`.toLowerCase();
  return [
    /git\s+(log|blame|history)/,
    /file:\d+/,
    /浠ｇ爜缁撴瀯/,
    /鏂囦欢璺緞/,
    /璋冭瘯瑙ｅ喅鏂规/,
    /淇閰嶆柟/,
    /任务态/,
    /褰撳墠浼氳瘽/,
    /JUE\.md/i,
  ].some((pattern) => pattern.test(text));
}

function matchesText(doc: MemoryDocument, text: string): boolean {
  const haystack = `${doc.frontmatter.name}\n${doc.frontmatter.description}\n${doc.body}\n${doc.frontmatter.tags.join(" ")}`.toLowerCase();
  return keywordScore(haystack, text.toLowerCase()) > 0;
}

function keywordScore(haystack: string, query: string): number {
  const tokens = query.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2);
  if (tokens.length === 0) return haystack.includes(query) ? 1 : 0;
  return tokens.filter((token) => haystack.includes(token)).length;
}

function firstSentence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const match = compact.match(/^(.{1,96}?)([銆?!?]|$)/);
  return ((match?.[1] ?? compact.slice(0, 96)) || "memory").trim();
}

/**
 * 涓?session/tool-result 浠撳簱鍏辩敤鐨勯」鐩《瑙勫垯銆傛瘡涓潪娉曞瓧绗﹂€愪釜杞负 -锛?
 * 涓嶆姌鍙犺繛缁í绾匡紝纭繚 memory 涓?sessions 钀藉湪鍚屼竴涓?projects/<slug> 涓嬨€?
 */
export function workspacePathSlug(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9_]/g, "-");
  return slug.length > 0 ? slug : "workspace";
}

/** 鏃?memory 鐩綍鐨勮浆涔夎鍒欙紝浠呯敤浜庤縼绉诲巻鍙叉暟鎹€?*/
export function sanitizeWorkspaceKey(workspaceRoot: string): string {
  return legacyWorkspacePathSlug(workspaceRoot);
}

function legacyWorkspacePathSlug(workspaceRoot: string): string {
  return resolve(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function migrateLegacyProjectMemoryDir(globalJueDir: string, workspaceRoot: string): void {
  const legacyDir = join(globalJueDir, legacyWorkspacePathSlug(workspaceRoot), MEMORY_ROOT_DIR);
  const projectDir = join(globalJueDir, "projects", workspacePathSlug(workspaceRoot), MEMORY_ROOT_DIR);
  if (!existsSync(legacyDir) || resolve(legacyDir) === resolve(projectDir)) return;

  if (!existsSync(projectDir)) {
    ensureDir(dirname(projectDir));
    renameSync(legacyDir, projectDir);
    ensureMemoryDir(projectDir);
    rewriteIndex(projectDir);
    removeLegacyWorkspaceBucketIfEmpty(globalJueDir, workspaceRoot);
    return;
  }

  ensureMemoryDir(projectDir);
  for (const filePath of listMarkdownFiles(legacyDir)) {
    if (basename(filePath).toLowerCase() === "memory.md") continue;
    renameSync(filePath, nextAvailablePath(join(projectDir, basename(filePath))));
  }
  rewriteIndex(projectDir);
  rmSync(legacyDir, { recursive: true, force: true });
  removeLegacyWorkspaceBucketIfEmpty(globalJueDir, workspaceRoot);
}

function removeLegacyWorkspaceBucketIfEmpty(globalJueDir: string, workspaceRoot: string): void {
  const legacyRoot = join(globalJueDir, legacyWorkspacePathSlug(workspaceRoot));
  if (!existsSync(legacyRoot)) return;
  try {
    if (readdirSync(legacyRoot).length === 0) rmSync(legacyRoot, { recursive: true, force: true });
  } catch {
    // 杩佺Щ娓呯悊澶辫触涓嶅簲褰卞搷 agent 鍚姩锛屽悗缁淮鎶や换鍔″彲鍐嶆澶勭悊銆?
  }
}

function nextAvailablePath(filePath: string): string {
  if (!existsSync(filePath)) return filePath;
  const dotIndex = filePath.toLowerCase().endsWith(".md") ? filePath.length - 3 : filePath.length;
  const base = filePath.slice(0, dotIndex);
  const ext = filePath.slice(dotIndex);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

function nextAvailableMemoryName(dir: string, type: MemoryDocumentType, baseName: string): string {
  const safeBase = baseName || `memory-${Date.now().toString(36)}`;
  let candidate = safeBase;
  for (let i = 1; i < 1000; i++) {
    if (!existsSync(join(dir, `${type}_${candidate}.md`))) return candidate;
    candidate = `${safeBase}-${i}`;
  }
  return `${safeBase}-${Date.now().toString(36)}`;
}

function slugify(input: string): string {
  const ascii = input
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii) return ascii.slice(0, 64);
  return `memory-${newId("slug").replace(/^slug_?/, "")}`;
}

function titleFromName(name: string): string {
  return name.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function relativeMemoryPath(baseDir: string, filePath: string): string {
  return relative(baseDir, filePath).replace(/\\/g, "/");
}




