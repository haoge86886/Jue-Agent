# Jue Agent

Jue Agent 是一个本地运行的 TypeScript 智能体项目，目标是提供类似 Claude Code / Codex 的多端 Agent 体验。当前重点实现了 CLI 入口、统一启动层、Prompt 组装、上下文工程、工具系统、SubAgent、Session 持久化、记忆模块和基础 Team 协作能力。

项目采用 monorepo 结构，核心运行逻辑拆分在 `packages/*` 中，用户入口位于 `apps/launcher`，终端界面位于 `apps/cli`。

## 安装

当前项目使用 pnpm 安装依赖并运行：

```bash
pnpm install
pnpm -r build
pnpm dev
```

运行后 Agent 会在当前目录启动，并在当前目录创建项目级 `.jue` 文件夹，同时读取用户目录下的全局配置。

## 配置

首次启动时会自动创建全局配置文件：

```text
<用户目录>/.jue/config.yaml
```

在该文件中配置模型服务地址、API Key 和模型名称，例如 OpenAI-compatible 服务的 `baseURL`、`apiKey`、`modelName` 等。

项目级文件会保存在当前工作目录：

```text
./.jue/
```

其中会保存项目指令、会话记录、上下文摘要和项目相关状态。


