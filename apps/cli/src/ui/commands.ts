/** Built-in slash command registry for the Ink CLI. */
export interface Command {
  name: string;
  description: string;
  usage?: string;
  implemented: boolean;
}

export const COMMANDS: Command[] = [
  { name: "help", description: "查看全部命令", implemented: true },
  { name: "clear", description: "清空当前屏幕消息，保留会话上下文", implemented: true },
  { name: "resume", description: "恢复一个历史会话", usage: "", implemented: true },
  { name: "reset", description: "丢弃当前会话上下文，下一条消息创建新会话", implemented: true },
  { name: "info", description: "打印当前 sessionId、model 和配置位置", implemented: true },
  { name: "compressor", description: "主动触发上下文压缩诊断，并在 /dev 信息中显示结果", usage: "", implemented: true },
  { name: "dream", description: "运行记忆整理维护", usage: "", implemented: true },
  { name: "team", description: "[实验功能,谨慎开启]开启或管理当前 session 的 Team 多 Agent 协作模式", usage: "/team start|run|status|cleanup|switch|add|task|send|claim|complete|off", implemented: true },
  { name: "exit", description: "退出 CLI", implemented: true },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function parseCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  if (!rest) return { name: "", args: [] };
  const parts = rest.split(/\s+/);
  return { name: parts[0]!.toLowerCase(), args: parts.slice(1) };
}
