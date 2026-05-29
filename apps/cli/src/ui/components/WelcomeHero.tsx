import React from "react";
import { Box, Text } from "ink";
import type { RootConfig } from "@jue/config";
import { TEXT } from "../theme.js";

interface WelcomeHeroProps {
  config: Readonly<RootConfig>;
  cwd: string;
  width: number;
}

const LOGO_LINES = [
"     ██╗██╗   ██╗███████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
"     ██║██║   ██║██╔════╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
"     ██║██║   ██║█████╗      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
"██   ██║██║   ██║██╔══╝      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
"╚█████╔╝╚██████╔╝███████╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
" ╚════╝  ╚═════╝ ╚══════╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
] as const;

const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => line.length));

export const WelcomeHero: React.FC<WelcomeHeroProps> = ({ config, cwd, width }) => {
  const stacked = width < LOGO_WIDTH + 34;
  const appVersion = process.env.npm_package_version ?? "dev";
  const panelWidth = stacked
    ? Math.max(30, Math.min(width, 52))
    : Math.max(30, width - LOGO_WIDTH - 4);

  const metaRows = [
    ["Version", appVersion],
    ["Environment", config.app.env],
    ["Model", config.model.routing.main],
    ["Frontend", "cli / ink"],
    ["Workspace", cwd],
  ] as const;

  return (
    <Box
      flexDirection={stacked ? "column" : "row"}
      marginTop={1}
      marginBottom={1}
      width={width}
    >
      <Box flexDirection="column" flexShrink={0}>
        {LOGO_LINES.map((line, index) => (
          <Text key={index} color="#d995e4" bold>
            {line}
          </Text>
        ))}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={0}
        marginLeft={stacked ? 0 : 3}
        marginTop={stacked ? 1 : 0}
        width={panelWidth}
      >
        <Text color={TEXT.primary} bold>
          Jue Agent
        </Text>
        <Text color={TEXT.muted}>Local assistant runtime</Text>
        <Box flexDirection="column" marginTop={1}>
          {metaRows.map(([label, value]) => (
            <Text key={label} color={TEXT.muted} wrap="truncate-end">
              {label.padEnd(12)} <Text color={TEXT.primary}>{value}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
};
