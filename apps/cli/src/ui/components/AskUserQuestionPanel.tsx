import React from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserQuestionResponse } from "@jue/tools";
import type { PendingAskUserQuestion } from "../ask-user-bridge.js";
import { TEXT } from "../theme.js";

interface Props {
  pending: PendingAskUserQuestion;
  onAnswer: (response: AskUserQuestionResponse) => void;
  onCancel?: () => void;
  width: number;
}

export const AskUserQuestionPanel: React.FC<Props> = ({ pending, onAnswer, onCancel, width }) => {
  const [selected, setSelected] = React.useState(0);
  const options = pending.request.options.length > 0
    ? pending.request.options
    : [
        { id: "approve_once", label: "批准单次指令" },
        { id: "approve_future", label: "批准后续所有此类指令" },
        { id: "reject", label: "拒绝并告诉 agent 怎么做" },
      ];

  React.useEffect(() => {
    setSelected(0);
  }, [pending.id]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((current) => Math.min(options.length - 1, current + 1));
      return;
    }
    if (key.return) {
      const option = options[selected];
      if (!option) return;
      onAnswer(toResponse(option.id));
    }
  });

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0}>
      <Text color="yellow" bold>需要用户确认</Text>
      <Text color={TEXT.muted}>原因: {pending.request.reason}</Text>
      <Text>{pending.request.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const label = `${index === selected ? "› " : "  "}${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`;
          return index === selected ? (
            <Text key={option.id} color="cyan" bold>{label}</Text>
          ) : (
            <Text key={option.id}>{label}</Text>
          );
        })}
      </Box>
      <Text color={TEXT.muted}>↑/↓ 选择，Enter 确认，Esc 取消询问</Text>
    </Box>
  );
};

function toResponse(optionId: string): AskUserQuestionResponse {
  if (optionId === "approve_once") {
    return { selectedOptionId: optionId, approved: true, approveSimilarFutureRequests: false };
  }
  if (optionId === "approve_future") {
    return { selectedOptionId: optionId, approved: true, approveSimilarFutureRequests: true };
  }
  return {
    selectedOptionId: optionId,
    approved: false,
    approveSimilarFutureRequests: false,
    instruction: "用户拒绝了该操作。请停止当前操作，并询问用户希望采用的替代方案。",
  };
}
