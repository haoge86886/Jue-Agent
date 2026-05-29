/**
 * @file schema/security.ts
 * @module @jue/config/schema/security
 *
 * 安全相关配置(对应 `configs/security.yaml`)。
 *
 * 涵盖五个领域:
 *   1. 远程访问(RemoteAccessConfig)— 是否对外开放、谁能进、限多少
 *   2. 敏感信息脱敏(SecretsRedactionConfig)— 日志/审计/共享前的关键字与值替换
 *   3. 权限策略(PermissionPolicy)— 工具默认作用域 + 高危工具名单
 *   4. 审计(AuditConfig)— 审计日志开关、保留期、告警
 *   5. CORS — Web 前端跨域来源白名单
 *
 * 安全默认值原则:**默认关闭、显式打开**。
 *   - 远程访问默认关闭
 *   - CORS 默认关闭
 *   - 审计默认开启(数据全部本地落盘)
 *   - 脱敏默认开启
 */

import { z } from "zod";
import { PermissionScopeSchema } from "@jue/shared-types";

/**
 * 认证方式。
 *   - `none`         : 无认证(仅本地 dev 使用)
 *   - `static_token` : 配置文件里写死的 token,适合个人/家庭部署
 *   - `jwt`          : 标准 JWT 校验
 *   - `oauth2`       : 接入第三方 OAuth2(具体 provider 在适配层处理)
 *   - `mtls`         : 双向 TLS,适合内网设备互访
 */
export const AuthMethodSchema = z.enum(["none", "static_token", "jwt", "oauth2", "mtls"]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/**
 * 远程认证配置。`shortLivedCodeTtlMs` 用于"扫码登录"等短期一次性凭据。
 */
export const RemoteAuthConfigSchema = z.object({
  method: AuthMethodSchema.default("static_token"),
  staticTokens: z.array(z.string()).default([]),
  jwtIssuer: z.string().optional(),
  jwtAudience: z.string().optional(),
  jwtPublicKey: z.string().optional(),
  shortLivedCodeTtlMs: z.number().int().positive().default(5 * 60 * 1000),
});
export type RemoteAuthConfig = z.infer<typeof RemoteAuthConfigSchema>;

/**
 * 限流配置。Token Bucket 类语义:
 *   - `windowMs`    : 统计窗口
 *   - `maxRequests` : 窗口内最大请求数
 *   - `burst`       : 允许突发的额外配额
 */
export const RateLimitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  windowMs: z.number().int().positive().default(60_000),
  maxRequests: z.number().int().positive().default(120),
  burst: z.number().int().nonnegative().default(20),
});
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/**
 * 远程访问配置。**默认关闭**。
 *
 * - `bindToLan`            : 即使开启,也仅监听 LAN 网卡,不暴露到公网
 * - `allowedIpCidrs`       : IP 段白名单;为空表示不限制
 * - `requireE2eEncryption` : 强制要求端到端加密(WSS / TLS / mTLS)
 */
export const RemoteAccessConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bindToLan: z.boolean().default(true),
  allowedIpCidrs: z.array(z.string()).default([]),
  blockedIpCidrs: z.array(z.string()).default([]),
  auth: RemoteAuthConfigSchema.optional(),
  rateLimit: RateLimitConfigSchema.optional(),
  requireE2eEncryption: z.boolean().default(false),
});
export type RemoteAccessConfig = z.infer<typeof RemoteAccessConfigSchema>;

/**
 * 敏感信息脱敏。
 *
 * 两层规则同时生效:
 *   - `keyPatterns`   : 匹配到的字段名,**整个值**被替换为 `replacement`
 *   - `valuePatterns` : 字段值中匹配到的子串,**子串**被替换
 *
 * 默认值已覆盖常见 OAuth/JWT/OpenAI key 形态,实际使用建议根据场景追加。
 */
export const SecretsRedactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  keyPatterns: z.array(z.string()).default([
    "(?i)password",
    "(?i)secret",
    "(?i)token",
    "(?i)api[_-]?key",
    "(?i)authorization",
  ]),
  valuePatterns: z.array(z.string()).default([
    "(?i)bearer\\s+[a-z0-9._\\-]+",
    "sk-[a-z0-9]{20,}",
  ]),
  replacement: z.string().default("***REDACTED***"),
});
export type SecretsRedactionConfig = z.infer<typeof SecretsRedactionConfigSchema>;

/**
 * 工具权限策略。`destructive/external` 名单影响 ConfirmationPolicy 的判定结果。
 *
 * - `defaultScope`        : 工具未声明 scope 时的默认值
 * - `alwaysConfirmTools`  : 强制确认名单(优先级最高)
 * - `autoApproveTools`    : 强制免确认名单
 */
export const PermissionPolicySchema = z.object({
  defaultScope: PermissionScopeSchema.default("user"),
  destructiveTools: z.array(z.string()).default([]),
  externalAccessTools: z.array(z.string()).default([]),
  alwaysConfirmTools: z.array(z.string()).default([]),
  autoApproveTools: z.array(z.string()).default([]),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/**
 * 审计日志配置。
 *
 * - `retainDays`     : 保留天数,过期日志被清理任务删除
 * - `alertOnDenials` : 出现 denied 事件时立即告警(具体告警通道在 audit 包内实现)
 */
export const AuditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retainDays: z.number().int().positive().default(180),
  alertOnDenials: z.boolean().default(true),
});
export type AuditConfig = z.infer<typeof AuditConfigSchema>;

/**
 * 安全领域配置主结构。
 *
 * `cors` 内联定义(没必要拆出独立 schema)。`allowedOrigins` 为空数组时,
 * 即使 `enabled: true`,实际效果等同于不允许任何跨域来源。
 */
export const SecurityConfigSchema = z.object({
  remoteAccess: RemoteAccessConfigSchema.optional(),
  secretsRedaction: SecretsRedactionConfigSchema.optional(),
  permissionPolicy: PermissionPolicySchema.optional(),
  audit: AuditConfigSchema.optional(),
  cors: z
    .object({
      enabled: z.boolean().default(false),
      allowedOrigins: z.array(z.string()).default([]),
    })
    .optional(),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
