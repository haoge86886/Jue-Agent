# @jue/config

`@jue/config` 负责加载、校验并冻结 Jue Agent 的运行配置。

当前生产策略是“用户可调运行策略，系统隐藏实现细节”：用户编辑 `<user-home>/.jue/config.yaml` 中的模型连接、上下文预算、工具确认、MCP、远端访问等运行策略；prompt 目录、日志目录、data/cache 路径、内部注册表等实现细节由代码默认值绑定，不暴露为用户配置 API。

## 用户配置

首次启动时会自动创建，核心结构如下：

```yaml
model:
  provider: openai
  modelName: qwen-plus
  baseURL: https://api.openai.com/v1
  apiKey: ""

runtime:
  maxIterations: 64

context:
  mainAgentBudget:
    totalTokenBudget: 100000
    reservedForResponse: 1024
  budgeter:
    ruleCompressionThreshold: 0.6
    llmCompressionThreshold: 0.85

tools:
  confirmation:
    mode: destructive_only
  mcpServers: []

security:
  remoteAccess:
    enabled: false
```

这个文件替代旧 `.env`。用户需要切换模型或网关时，直接修改 `provider`、`modelName`、`baseURL`、`apiKey` 即可。

## 暴露边界

允许用户配置：

- `model`: provider、modelName、baseURL、apiKey、采样和 token 输出上限。
- `runtime.maxIterations`: Agent Loop 最大步数。
- `context`: 主 agent/subagent 预算、压缩阈值、规则压缩策略。
- `tools`: 内置工具开关、确认策略、MCP server 列表。
- `security.remoteAccess`: 远端访问开关和基础安全策略。

不向用户暴露：

- `app.paths`: prompt/data/log/cache/snapshot 等内部路径。
- `app.telemetry`: 开发日志细节。
- `memory/recommendation/security.audit`: 目前仍由系统默认值管理，等对应产品形态稳定后再开放。

## 系统默认配置

系统内部默认值位于 `src/default-config.ts` 的 `SYSTEM_DEFAULT_CONFIG`。这些值包括：

- prompt、data、log、snapshot、temp 等内部路径。
- 内置工具开关、确认策略、MCP 默认列表。
- memory、recommendation、security、context 的默认行为。
- 模型采样、超时、上下文窗口等默认参数。

加载器会把用户简化配置展开成 runtime 需要的 `RootConfig.model.profiles/routing` 结构，再与系统默认配置一起通过 Zod schema 校验。

## 兼容入口

`configsDir` 多 YAML 目录仍保留为显式兼容模式，主要用于测试或迁移旧项目。普通用户和生产入口不应继续使用它。

`.env` 加载已经废弃，`envFile/loadDotenv/getEnvFile()` 仅为旧调用方保留类型兼容，不再实际读取文件。
