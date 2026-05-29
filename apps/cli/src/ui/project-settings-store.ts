import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface ApprovalRecord {
  key: string;
  createdAt: number;
  updatedAt: number;
}

interface ProjectSettingsFile {
  version: 1;
  approvals: {
    autoApproveTools: ApprovalRecord[];
  };
  permissions?: {
    allowedRoots?: string[];
  };
}

interface LegacyApprovalFile {
  version?: number;
  approvals?: ApprovalRecord[];
}

/**
 * 项目级 CLI 设置存储。所有后续需要落盘的项目偏好都应进入 .jue/settings.json，
 * 通过命名字段扩展，避免在 .jue 下散落多个小 JSON 文件。
 */
export class ProjectSettingsStore {
  private readonly path: string;
  private approvals = new Map<string, ApprovalRecord>();
  private allowedRoots = new Set<string>();

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  hasAutoApproval(key: string): boolean {
    return this.approvals.has(key);
  }

  approveToolAutomatically(key: string): void {
    const now = Date.now();
    const existing = this.approvals.get(key);
    this.approvals.set(key, {
      key,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.save();
  }

  listAllowedRoots(): string[] {
    return [...this.allowedRoots.values()].sort((a, b) => a.localeCompare(b));
  }

  allowRoot(root: string): void {
    if (!root.trim()) return;
    this.allowedRoots.add(root.trim());
    this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const records = extractApprovalRecords(parsed);
      for (const item of records) {
        if (typeof item.key !== "string" || !isScopedApprovalKey(item.key)) continue;
        this.approvals.set(item.key, {
          key: item.key,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
          updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
        });
      }
      for (const root of extractAllowedRoots(parsed)) {
        this.allowedRoots.add(root);
      }
    } catch {
      this.approvals.clear();
      this.allowedRoots.clear();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: ProjectSettingsFile = {
      version: 1,
      approvals: {
        autoApproveTools: [...this.approvals.values()].sort((a, b) => a.key.localeCompare(b.key)),
      },
      permissions: {
        allowedRoots: this.listAllowedRoots(),
      },
    };
    writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

function extractAllowedRoots(value: unknown): string[] {
  if (!isObject(value) || !isObject(value.permissions) || !Array.isArray(value.permissions.allowedRoots)) return [];
  return value.permissions.allowedRoots.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isScopedApprovalKey(key: string): boolean {
  return key.startsWith("tool:") && key.split(":").length >= 4;
}

function extractApprovalRecords(value: unknown): ApprovalRecord[] {
  if (!isObject(value)) return [];
  const approvals = value.approvals;
  if (Array.isArray(approvals)) return approvals.filter(isApprovalRecord);
  if (isObject(approvals) && Array.isArray(approvals.autoApproveTools)) {
    return approvals.autoApproveTools.filter(isApprovalRecord);
  }
  return [];
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  return isObject(value) && typeof value.key === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
