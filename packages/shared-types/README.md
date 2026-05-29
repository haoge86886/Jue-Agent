# @jue/shared-types

jue_agent 项目的**协议契约层**,为所有其他包(config / prompting / context / tool / memory / subagent / recommendation / engine / 各 frontend)提供统一的数据形状定义。

## 目录

```
src/
├─ common.ts          # Id/Timestamp/Status/Sensitivity/Metadata 等通用原子
├─ session.ts         # SessionRequest/MessageDraft/Message/StreamEvent/SessionResponse
├─ context.ts         # ContextBlock + 类型/来源/压缩策略枚举
├─ tool.ts            # ToolSpec/ToolCall/ToolResult + JsonSchemaLike
├─ memory.ts          # MemoryRecord/MemoryQuery/MemorySharingPolicy
├─ subagent.ts        # SubAgentTask/SubAgentResult/SubAgentBudget
├─ recommendation.ts  # InterestProfile/RecommendationItem/Batch
├─ audit.ts           # AuditEvent/AuditActor/AuditTarget
└─ index.ts           # 总导出
```

## 使用约定

- 命名:`XxxSchema` 是 Zod schema(运行时校验),`Xxx` 是由 `z.infer` 派生的 TS 类型
- 跨包/跨进程数据进入本系统前,**必须**经过对应 schema 的 `safeParse` / `parse`,不要裸 cast
- 子路径导入(避免不必要的整包加载):

  ```ts
  import { ToolSpecSchema } from "@jue/shared-types/tool";
  import { MessageSchema } from "@jue/shared-types/session";
  ```

## 设计要点

1. **Zod 4 优先,字段级 default 为主**
   - 嵌套对象 schema 不要用 `.default({})`(Zod 4 类型推导不兼容,会报"missing properties")
   - 改为外层 `.optional()`,内层字段保留 `.default(...)`,运行时 `parse` 时仍能补全

2. **`exactOptionalPropertyTypes: true` 下手写类型必须显式 `| undefined`**
   - 见 `tool.ts` 中 `JsonSchemaLike` 的写法
   - 否则与 `z.infer` 推导出的类型不兼容

3. **`MessageDraft` 与 `Message` 分离**
   - 前端入站用 `MessageDraft`(只含用户能填的字段)
   - 系统持久化用 `Message`(补齐 id/sessionId/createdAt 等系统字段)

4. **图片/文件 part 必须至少一个定位字段**
   - `ImagePart`: `url` 与 `base64` 至少一个,通过 `.refine` 强校验
   - `FilePart`: `url` 与 `path` 至少一个

5. **策略字段绑定枚举,不裸 string**
   - `SubAgentContextPolicy.allowedContextTypes` → `ContextBlockTypeSchema[]`
   - `allowedMemoryScopes` → `MemoryScopeSchema[]`
   - 唯一例外:`allowedToolNames`(工具是动态注册的,不能静态枚举)

## 与设计书对应

设计书 §6.2 明确了 8 个领域 schema,本包逐项落地:
session / context / tool / memory / subagent / recommendation / audit + common 基础类型。
