import { createInterface } from "node:readline/promises";

import { supportsTrueColor, createStyler, type Styler } from "./theme";
import { InstallerError, type DownloadProgress } from "./types";

export interface StepDefinition {
  id: string;
  label: string;
  detail?: string;
}

type StepStatus = "pending" | "active" | "done" | "failed";

interface StepState extends StepDefinition {
  status: StepStatus;
  detail?: string;
}

export interface InstallerUIOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  color?: boolean;
  animations?: boolean;
  width?: number;
}

export interface InstallerSummary {
  version: string;
  binaryPath: string;
  commandPath: string;
  pathChanged: boolean;
  pathOnPath: boolean;
}

const SPINNER = ["◐", "◓", "◑", "◒"];
const GLYPHS: Record<StepStatus, string> = {
  pending: "○",
  active: "◆",
  done: "●",
  failed: "×",
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

export function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const output: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      output.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      let breakAt = rest.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      output.push(rest.slice(0, breakAt));
      rest = rest.slice(breakAt).trimStart();
    }
    output.push(rest);
  }
  return output;
}

export class InstallerUI {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
  readonly animations: boolean;
  readonly color: boolean;
  readonly width: number;
  readonly signal: AbortSignal;

  private readonly styler: Styler;
  private readonly abortController = new AbortController();
  private readonly onSigint = () => {
    this.interrupted = true;
    this.abortController.abort();
    this.close();
  };
  private steps: StepState[] = [];
  private lastStepLines = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private spinnerFrame = 0;
  private lastRenderAt = 0;
  private lastPercent = -1;
  private live = false;
  private closed = false;
  private lastStage = "";
  interrupted = false;

  constructor(options: InstallerUIOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.stdin = options.stdin ?? process.stdin;
    this.env = options.env ?? process.env;
    this.interactive =
      options.interactive ??
      Boolean(this.stdout.isTTY && this.stdin.isTTY && !this.env.CI && this.env.TERM !== "dumb");
    this.color =
      options.color ??
      Boolean(this.stdout.isTTY && !this.env.NO_COLOR && this.env.TERM !== "dumb");
    this.animations =
      options.animations ??
      (this.interactive && !this.env.CI && !this.env.ORCHIVOX_NO_ANIM);
    const columns =
      options.width ?? (this.stdout.columns && this.stdout.columns > 0 ? this.stdout.columns : 80);
    this.width = Math.max(20, Math.min(columns, 72));
    this.signal = this.abortController.signal;
    this.styler = createStyler({
      color: this.color,
      trueColor: supportsTrueColor(this.env),
    });
    process.once("SIGINT", this.onSigint);
  }

  async banner(version: string, platform: string): Promise<void> {
    if (!this.interactive) {
      this.writePlain(`Orchivox ${version} for ${platform}`);
      return;
    }

    this.stdout.write(`\n${this.styler.accent("◆ ORCHIVOX")}\n`);
    this.stdout.write(`${this.styler.muted("personal coding agent")}\n`);
    const rule = "─".repeat(Math.min(this.width, 36));
    if (this.animations) {
      for (let index = 2; index <= rule.length; index += 4) {
        this.stdout.write(`\r${this.styler.muted(rule.slice(0, index))}`);
        await sleep(8);
      }
      this.stdout.write(`\r${this.styler.muted(rule)}\n`);
    } else {
      this.stdout.write(`${this.styler.muted(rule)}\n`);
    }
    this.stdout.write("\n");
    this.writeStyled(`Orchivox ${version} for ${platform}`, this.styler.text);
  }

  intro(version: string, channel: string, size: number): void {
    if (!this.interactive) {
      this.writePlain(
        `Installing Orchivox ${version} (${channel}), ${formatBytes(size)}.`,
      );
      return;
    }
    this.stdout.write("\n");
    this.writeStyled(`Install Orchivox ${version} (${channel})?`, this.styler.text);
    this.writeStyled(
      `Download ${formatBytes(size)}. Config and sessions are not touched.`,
      this.styler.muted,
    );
    this.stdout.write("\n");
  }

  async confirm(question: string, defaultValue: boolean, automatic = false): Promise<boolean> {
    if (!this.interactive || automatic) return defaultValue;
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    const prompt = `${this.styler.accent("❯")} ${question} ${suffix} `;
    const rl = createInterface({
      input: this.stdin,
      output: this.stdout,
      terminal: true,
      signal: this.signal,
    });
    try {
      const answer = (await rl.question(prompt)).trim().toLowerCase();
      if (answer === "") return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      return defaultValue;
    } catch (error) {
      if (this.interrupted || this.signal.aborted) {
        throw new InstallerError("cancelled", "Installation cancelled.");
      }
      throw error;
    } finally {
      rl.close();
    }
  }

  startSteps(steps: StepDefinition[], completed: string[] = []): void {
    this.steps = steps.map((step) => ({
      ...step,
      status: completed.includes(step.id) ? "done" : "pending",
    }));
    this.lastStepLines = 0;
    this.live = true;
    if (this.interactive) {
      this.stdout.write("\x1b[?25l");
      this.renderSteps();
      this.startSpinner();
    }
  }

  stage(id: string, detail?: string): void {
    const index = this.steps.findIndex((step) => step.id === id);
    if (index === -1) return;
    for (let cursor = 0; cursor < index; cursor += 1) {
      if (this.steps[cursor].status !== "failed") this.steps[cursor].status = "done";
    }
    const current = this.steps[index];
    current.status = "active";
    if (detail) current.detail = detail;

    if (!this.interactive) {
      if (id === "download" && this.lastStage !== id) {
        this.stdout.write(`Downloading${detail ? ` ${detail}` : ""}...\n`);
      } else if (id === "install" && this.lastStage !== id) {
        this.stdout.write("Installing...\n");
      } else if (id === "link" && this.lastStage !== id) {
        this.stdout.write("Linking command...\n");
      }
      this.lastStage = id;
      return;
    }
    this.renderSteps();
    this.startSpinner();
  }

  progress(progress: DownloadProgress): void {
    const active = this.steps.find((step) => step.status === "active");
    if (!active || active.id !== "download") return;
    active.detail = this.progressText(progress);

    if (!this.interactive) {
      if (progress.percent >= this.lastPercent + 25 || progress.percent >= 100) {
        this.lastPercent = Math.floor(progress.percent / 25) * 25;
        this.stdout.write(
          `  ${Math.round(progress.percent)}% ${formatBytes(progress.received)} / ${formatBytes(progress.total)}\n`,
        );
      }
      return;
    }

    const now = Date.now();
    if (progress.percent < 100 && now - this.lastRenderAt < 80) return;
    this.lastRenderAt = now;
    this.renderSteps();
  }

  completeStep(id: string, detail?: string): void {
    const step = this.steps.find((entry) => entry.id === id);
    if (!step) return;
    step.status = "done";
    if (detail) step.detail = detail;
    if (this.interactive) this.renderSteps();
  }

  finishSteps(): void {
    for (const step of this.steps) {
      if (step.status !== "failed") step.status = "done";
    }
    this.stopSpinner();
    if (this.interactive) {
      this.renderSteps();
      this.stdout.write("\x1b[?25h");
    } else if (this.steps.length > 0) {
      this.stdout.write("Done.\n");
    }
    this.live = false;
  }

  failStep(id: string, detail?: string): void {
    const step = this.steps.find((entry) => entry.id === id);
    if (step) {
      step.status = "failed";
      if (detail) step.detail = detail;
    }
    this.stopSpinner();
    if (this.interactive) {
      this.renderSteps();
      this.stdout.write("\x1b[?25h");
    }
    this.live = false;
  }

  failActive(detail?: string): void {
    const active = this.steps.find((entry) => entry.status === "active");
    if (active) {
      this.failStep(active.id, detail);
      return;
    }
    const last = [...this.steps].reverse().find((entry) => entry.status !== "done");
    if (last) this.failStep(last.id, detail);
  }

  summary(summary: InstallerSummary): void {
    if (!this.interactive) {
      this.writePlain(`Installed Orchivox ${summary.version} at ${summary.binaryPath}`);
      return;
    }
    const command = summary.pathOnPath ? "orchivox" : summary.commandPath;
    this.stdout.write(
      `\n${this.styler.success("●")} ${this.styler.bold(`Orchivox ${summary.version} is ready.`)}\n`,
    );
    this.writePlain(`  command  ${command}`);
    this.writePlain(`  binary   ${summary.binaryPath}`);
    this.writePlain("  config   ~/.orchivox/config.yaml (unchanged)");
    if (summary.pathChanged) {
      this.writePlain("  PATH updated. Restart your shell to use the new command.");
    }
  }

  info(message: string): void {
    this.writePlain(message);
  }

  warn(message: string): void {
    const prefix = this.styler.accent("warning:");
    for (const [index, line] of wrapText(message, Math.max(1, this.width - 9)).entries()) {
      this.stderr.write(`${index === 0 ? `${prefix} ` : " ".repeat(9)}${line}\n`);
    }
  }

  error(message: string): void {
    const prefix = this.styler.error("error:");
    for (const [index, line] of wrapText(message, Math.max(1, this.width - 7)).entries()) {
      this.stderr.write(`${index === 0 ? `${prefix} ` : " ".repeat(7)}${line}\n`);
    }
  }

  private writePlain(text: string, stream: NodeJS.WriteStream = this.stdout): void {
    for (const line of wrapText(text, this.width)) stream.write(`${line}\n`);
  }

  private writeStyled(text: string, style: (value: string) => string): void {
    for (const line of wrapText(text, this.width)) {
      this.stdout.write(`${style(line)}\n`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSpinner();
    process.removeListener("SIGINT", this.onSigint);
    if (this.interactive) this.stdout.write("\x1b[?25h");
  }

  private startSpinner(): void {
    if (!this.animations || this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      if (!this.live) return;
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.renderSteps();
    }, 120);
    this.spinnerTimer.unref?.();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  private renderSteps(): void {
    if (!this.interactive || this.steps.length === 0) return;
    const lines = this.stepLines();
    if (this.lastStepLines > 0) {
      this.stdout.write(`\x1b[${this.lastStepLines}A`);
    }
    const count = Math.max(this.lastStepLines, lines.length);
    for (let index = 0; index < count; index += 1) {
      this.stdout.write(`\x1b[2K${lines[index] ?? ""}\n`);
    }
    this.lastStepLines = count;
  }

  private stepLines(): string[] {
    const compact = this.width < 56;
    const labelWidth = compact
      ? Math.min(16, Math.max(10, Math.floor(this.width * 0.4)))
      : 18;
    return this.steps.map((step) => {
      const glyph =
        step.status === "active" && this.animations
          ? SPINNER[this.spinnerFrame]
          : GLYPHS[step.status];
      const label = fitLine(step.label, labelWidth).padEnd(labelWidth, " ");
      const available = Math.max(0, this.width - labelWidth - 4);
      const detail = step.detail ? fitLine(step.detail, available) : "";
      const line = fitLine(`  ${glyph} ${label} ${detail}`.trimEnd(), this.width);
      return this.paint(line, step.status);
    });
  }

  private paint(line: string, status: StepStatus): string {
    if (status === "active") return this.styler.accent(line);
    if (status === "done") return this.styler.success(line);
    if (status === "failed") return this.styler.error(line);
    return this.styler.muted(this.styler.dim(line));
  }

  private progressText(progress: DownloadProgress): string {
    const percent = Math.round(progress.percent);
    const received = formatBytes(progress.received);
    const total = formatBytes(progress.total);
    const compact = `${percent}% ${received}/${total}`;
    if (this.width < 56) return compact;

    const available = Math.max(0, this.width - 22);
    const barWidth = Math.max(8, Math.min(18, available - 34));
    const filled = Math.round((progress.percent / 100) * barWidth);
    const bar = `${"━".repeat(filled)}${"─".repeat(Math.max(0, barWidth - filled))}`;
    const medium = `${bar} ${percent}%  ${received}/${total}  ${formatSpeed(progress.bytesPerSecond)}`;
    const full = `${medium}  ETA ${formatEta(progress.etaSeconds)}`;
    if (full.length <= available) return full;
    if (medium.length <= available) return medium;
    return compact;
  }
}

export function createInstallerUI(options: InstallerUIOptions = {}): InstallerUI {
  return new InstallerUI(options);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
