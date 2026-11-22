import React from "react";
import { Box, Text } from "ink";
import type { UpdateOffer, UpdateStage } from "../app-info";
import type { DownloadProgress } from "../installer/types";
import { formatBytes } from "../installer/ui";
import { ChoiceModal } from "./choice-modal";
import { InstallationLogo, OrchivoxLogo } from "./logo";
import { INSTALLATION_LOGO_HEIGHT, INSTALLATION_LOGO_WIDTH } from "./logo-art";
import { Spinner } from "./spinner";
import { fitDisplayText } from "./text-wrap";
import type { Theme } from "./theme";

export type UpdateView =
  | { kind: "checking" }
  | { kind: "offer"; offer: UpdateOffer }
  | { kind: "installing"; target: string; stage: UpdateStage; progress?: DownloadProgress };

const STAGES: Record<UpdateStage, string> = {
  download: "Downloading release",
  verify: "Verifying download",
  install: "Installing binary",
  link: "Activating version",
  sync: "Updating checkout",
  dependencies: "Installing dependencies",
  build: "Building and installing binary",
};

export function UpdatePanel({ view, width, height, theme, onDecision }: {
  view: UpdateView;
  width: number;
  height: number;
  theme: Theme;
  onDecision: (approved: boolean) => void;
}) {
  if (view.kind === "offer") {
    const { current, target, detail } = view.offer;
    return <ChoiceModal title="Orchivox update" subtitle={`${current} → ${target} · ${detail}`}
      width={width} theme={theme} initialIndex={1}
      options={[
        { id: "install", label: "Update now", description: "" },
        { id: "later", label: "Later", description: "" },
      ]}
      onSelect={(id) => onDecision(id === "install")} onCancel={() => onDecision(false)} />;
  }

  const installing = view.kind === "installing";
  const sideBySide = installing && height >= INSTALLATION_LOGO_HEIGHT && width >= INSTALLATION_LOGO_WIDTH + 32;
  const stacked = installing && height >= INSTALLATION_LOGO_HEIGHT + 5 && width >= INSTALLATION_LOGO_WIDTH + 2;
  const showOrbit = sideBySide || stacked;
  const contentWidth = width - (sideBySide ? INSTALLATION_LOGO_WIDTH + 2 : 0) - 2;
  const progress = installing && view.stage === "download" ? view.progress : undefined;
  const percent = progress ? Math.round(Math.max(0, Math.min(100, progress.percent))) : 0;
  const barWidth = Math.max(1, Math.min(20, contentWidth - 2));
  const filled = Math.floor(percent * barWidth / 100);
  const status = view.kind === "checking" ? "Checking for updates" : STAGES[view.stage];
  return <Box flexDirection={sideBySide ? "row" : "column"} width={width} paddingX={1}
    columnGap={2} rowGap={1} alignItems="flex-start">
    {showOrbit ? <InstallationLogo theme={theme} />
      : !installing && height >= 10 ? <OrchivoxLogo small theme={theme} /> : null}
    <Box flexDirection="column" width={Math.max(1, contentWidth)} marginTop={sideBySide ? 1 : 0}>
      {height >= 2 ? <Text bold color={theme.text} wrap="truncate">
        {!showOrbit && width >= 20 && installing ? <><OrchivoxLogo variant="compact" theme={theme} />{" "}</> : null}
        {installing ? `Orchivox update · ${view.target}` : "Orchivox update"}
      </Text> : null}
      <Text color={theme.text} wrap="truncate">
        <Spinner active color={theme.accent} />
        {fitDisplayText(status, Math.max(1, contentWidth - 2))}
      </Text>
      {progress && height >= 3 ? <Text color={theme.muted} wrap="truncate">
        {fitDisplayText(`${percent}% · ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`, contentWidth)}
      </Text> : null}
      {progress && height >= 4 ? <Text color={theme.muted} wrap="truncate">
        <Text color={theme.accent}>{"█".repeat(filled)}</Text>{"░".repeat(barWidth - filled)}
      </Text> : null}
    </Box>
  </Box>;
}
