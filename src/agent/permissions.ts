import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { applyPatch } from "diff";

import type { AgentMode, ToolCall } from "../types/schema";
import { readText, splitLines } from "../tools/hashline-edit";

export type PermissionAction = "allow" | "ask" | "deny";

export type ApprovalChoice = "approve_once" | "always_allow" | "deny" | "deny_with_feedback";

export interface ShellRiskDetails {
  command: string;
  cwd: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  warning?: string;
}

export interface DiffPreviewDetails {
  filePath: string;
  oldText: string;
  newText: string;
  oldLabel?: string;
  newLabel?: string;
}

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  mode: AgentMode;
  readOnly: boolean;
  filePath?: string;
  diffPreview?: DiffPreviewDetails;
  shellDetails?: ShellRiskDetails;
  reason?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  choice: ApprovalChoice;
  feedback?: string;
  reason?: string;
}

export interface ToolRulePattern {
  raw: string;
  toolName: string;
  pattern: string;
  action: PermissionAction;
}

export interface GranularPermissionEngineOptions {
  repoRoot?: string;
  rules?: Array<ToolRulePattern | string>;
  safeCommands?: string[];
  dangerousCommands?: string[];
  safePaths?: string[];
}

const FATAL_COMMAND_PATTERNS = [
  /\brm\s+-[a-zA-Z0-9]*r[a-zA-Z0-9]*f\s+([/~*]|\.\.)/i,
  /\brm\s+-[a-zA-Z0-9]*f[a-zA-Z0-9]*r\s+([/~*]|\.\.)/i,
  /\bgit\s+push\s+.*(--force|-f\b)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+-[a-zA-Z0-9]*R\s+777\s+[/~]/i,
];

const HIGH_RISK_COMMAND_PATTERNS = [
  /\brm\s+/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-zA-Z0-9]*f/i,
  /\bkill\s+-9/i,
  /\bpkill\s+/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
];

const MEDIUM_RISK_COMMAND_PATTERNS = [
  /\b(npm|bun|pnpm|yarn)\s+(install|add|remove|update)\b/i,
  /\bgit\s+(checkout|commit|merge|rebase|pull|branch\s+-D)\b/i,
  /\b(mv|cp)\s+/i,
  /\bchmod\b/i,
  /\bchown\b/i,
];

export function parseToolRule(ruleInput: ToolRulePattern | string): ToolRulePattern {
  if (typeof ruleInput !== "string") {
    return ruleInput;
  }

  const match = /^([a-zA-Z0-9_-]+)\(([^)]+)\)\s*(?:->\s*([a-zA-Z]+))?$/.exec(ruleInput.trim());
  if (match) {
    const toolName = match[1];
    const pattern = match[2].trim();
    const actionStr = (match[3] ?? "ask").toLowerCase();
    const action: PermissionAction =
      actionStr === "allow" ? "allow" : actionStr === "deny" ? "deny" : "ask";

    return { raw: ruleInput, toolName, pattern, action };
  }

  return {
    raw: ruleInput,
    toolName: "*",
    pattern: ruleInput.trim(),
    action: "ask",
  };
}

export function evaluateShellRisk(command: string, cwd: string): ShellRiskDetails {
  const trimmed = command.trim();

  for (const pattern of FATAL_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        command: trimmed,
        cwd,
        riskLevel: "critical",
        warning: "Fatal command may permanently damage the system or repository.",
      };
    }
  }

  for (const pattern of HIGH_RISK_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        command: trimmed,
        cwd,
        riskLevel: "high",
        warning: "This command deletes or overwrites files/history irreversibly.",
      };
    }
  }

  for (const pattern of MEDIUM_RISK_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        command: trimmed,
        cwd,
        riskLevel: "medium",
        warning: "This command modifies dependencies or git branch structure.",
      };
    }
  }

  return {
    command: trimmed,
    cwd,
    riskLevel: "low",
  };
}

export async function calculateDiffPreview(
  toolName: string,
  args: Record<string, unknown>,
  repoRoot: string,
): Promise<DiffPreviewDetails | undefined> {
  const rawPath = typeof args.filePath === "string" ? args.filePath : undefined;
  if (!rawPath) return undefined;

  const fullPath = resolve(repoRoot, rawPath);
  let oldText = "";
  try {
    oldText = await readText(fullPath);
  } catch {
    oldText = "";
  }

  if (toolName === "hash_edit") {
    let hunks: Array<{ startAnchor: string; endAnchor: string; newContent: string }> = [];
    if (Array.isArray(args.edits) && args.edits.length > 0) {
      hunks = args.edits as Array<{ startAnchor: string; endAnchor: string; newContent: string }>;
    } else if (typeof args.startAnchor === "string" && typeof args.endAnchor === "string") {
      hunks = [{
        startAnchor: args.startAnchor,
        endAnchor: args.endAnchor,
        newContent: typeof args.newContent === "string" ? args.newContent : "",
      }];
    }

    if (hunks.length > 0) {
      let lines = splitLines(oldText);
      const parsedHunks = hunks.map((hunk) => {
        const startLineMatch = /^(\d+):[0-9a-f]{3}$/.exec(hunk.startAnchor);
        const endLineMatch = /^(\d+):[0-9a-f]{3}$/.exec(hunk.endAnchor);
        const startLine = startLineMatch ? Number.parseInt(startLineMatch[1], 10) : 1;
        const endLine = endLineMatch ? Number.parseInt(endLineMatch[1], 10) : startLine;
        return { startLine, endLine, newContent: hunk.newContent };
      });

      parsedHunks.sort((a, b) => b.startLine - a.startLine);

      for (const hunk of parsedHunks) {
        const replacement = hunk.newContent === "" ? [] : splitLines(hunk.newContent);
        lines = [
          ...lines.slice(0, Math.max(0, hunk.startLine - 1)),
          ...replacement,
          ...lines.slice(hunk.endLine),
        ];
      }

      const newText = lines.join("\n") + (oldText.endsWith("\n") && lines.length > 0 ? "\n" : "");
      return {
        filePath: rawPath,
        oldText,
        newText,
        oldLabel: `${rawPath} (current)`,
        newLabel: `${rawPath} (proposed ${hunks.length} hunk edit)`,
      };
    }
  }

  if (toolName === "write_file" || toolName === "create_file") {
    const newText = typeof args.content === "string" ? args.content : "";
    return {
      filePath: rawPath,
      oldText,
      newText,
      oldLabel: oldText.length > 0 ? `${rawPath} (previous)` : `${rawPath} (new file)`,
      newLabel: `${rawPath} (new)`,
    };
  }

  if (toolName === "delete_file") {
    return {
      filePath: rawPath,
      oldText,
      newText: "",
      oldLabel: `${rawPath} (current)`,
      newLabel: `${rawPath} (deleted)`,
    };
  }

  if (toolName === "apply_unified_patch" && typeof args.patch === "string") {
    const patched = applyPatch(oldText, args.patch);
    const newText = typeof patched === "string" ? patched : oldText;
    return {
      filePath: rawPath,
      oldText,
      newText,
      oldLabel: `${rawPath} (current)`,
      newLabel: `${rawPath} (after patch)`,
    };
  }

  return undefined;
}

export class GranularPermissionEngine extends EventEmitter {
  private readonly repoRoot: string;
  private readonly rules: ToolRulePattern[] = [];
  private readonly sessionAllowlist = new Set<string>();
  private approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision>;

  constructor(options: GranularPermissionEngineOptions = {}) {
    super();
    this.repoRoot = options.repoRoot ?? globalThis.process.cwd();
    for (const rule of options.rules ?? []) {
      this.rules.push(parseToolRule(rule));
    }
  }

  addRule(rule: ToolRulePattern | string): void {
    this.rules.push(parseToolRule(rule));
  }

  setApprovalHandler(handler: (request: ApprovalRequest) => Promise<ApprovalDecision>): void {
    this.approvalHandler = handler;
  }

  clearSessionAllowlist(): void {
    this.sessionAllowlist.clear();
  }

  getSessionAllowlist(): string[] {
    return [...this.sessionAllowlist];
  }

  isSessionAllowed(toolName: string, targetKey: string): boolean {
    return (
      this.sessionAllowlist.has(`${toolName}:${targetKey}`) ||
      this.sessionAllowlist.has(`${toolName}:*`) ||
      this.sessionAllowlist.has(`*:${targetKey}`)
    );
  }

  allowInSession(toolName: string, targetKey: string): void {
    this.sessionAllowlist.add(`${toolName}:${targetKey}`);
  }

  async check(
    tool: { name: string; readOnly: boolean },
    mode: AgentMode,
    args?: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string; feedback?: string }> {
    return this.checkPermission(tool, args ?? {}, mode);
  }

  async checkPermission(
    tool: { name: string; readOnly: boolean },
    args: Record<string, unknown>,
    mode: AgentMode,
    toolCallId = `call-${Date.now()}`,
  ): Promise<{ allowed: boolean; reason?: string; feedback?: string }> {
    const targetKey = this.extractTargetKey(tool.name, args);

    if (this.isSessionAllowed(tool.name, targetKey)) {
      return { allowed: true };
    }

    const matchedRule = this.matchConfigRule(tool.name, targetKey);
    if (matchedRule) {
      if (matchedRule.action === "allow") return { allowed: true };
      if (matchedRule.action === "deny") {
        return {
          allowed: false,
          reason: `Denied by configuration rule: ${matchedRule.raw}`,
        };
      }
    }

    if (mode === "plan") {
      if (!tool.readOnly) {
        return {
          allowed: false,
          reason: `Tool "${tool.name}" modifies files or state, and PLAN mode only allows read-only tools.`,
        };
      }
      return { allowed: true };
    }

    let shellRisk: ShellRiskDetails | undefined;
    if ((tool.name === "bash" || tool.name === "bg_start") && typeof args.command === "string") {
      const cwd = typeof args.cwd === "string" ? args.cwd : this.repoRoot;
      shellRisk = evaluateShellRisk(args.command, cwd);
    }

    if (mode === "ultrawork") {
      if (shellRisk?.riskLevel === "critical") {
        return {
          allowed: false,
          reason: `Fatal command "${shellRisk.command}" automatically denied in ULTRAWORK mode: ${shellRisk.warning}`,
        };
      }
      return { allowed: true };
    }

    if (tool.readOnly) {
      return { allowed: true };
    }

    const diffPreview = await calculateDiffPreview(tool.name, args, this.repoRoot);
    const request: ApprovalRequest = {
      id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      toolCallId,
      toolName: tool.name,
      args,
      mode,
      readOnly: tool.readOnly,
      filePath: typeof args.filePath === "string" ? args.filePath : undefined,
      diffPreview,
      shellDetails: shellRisk,
      reason: shellRisk?.warning ?? "This tool requires approval before executing changes.",
    };

    const decision = await this.requestApproval(request);

    if (decision.approved) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: decision.reason ?? "Tool execution denied by user.",
      feedback: decision.feedback,
    };
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const targetKey = this.extractTargetKey(request.toolName, request.args);

    if (this.isSessionAllowed(request.toolName, targetKey)) {
      return { approved: true, choice: "always_allow" };
    }

    this.emit("approval_requested", request);

    let decision: ApprovalDecision;
    if (this.approvalHandler) {
      decision = await this.approvalHandler(request);
    } else {
      decision = {
        approved: false,
        choice: "deny",
        reason: "No interactive approval handler attached.",
      };
    }

    if (decision.choice === "always_allow") {
      this.allowInSession(request.toolName, targetKey);
    }

    this.emit("approval_resolved", { request, decision });
    return decision;
  }

  private extractTargetKey(toolName: string, args: Record<string, unknown>): string {
    if ((toolName === "bash" || toolName === "bg_start") && typeof args.command === "string") {
      return args.command.trim();
    }
    if (typeof args.filePath === "string") {
      return args.filePath.trim();
    }
    return "*";
  }

  private matchConfigRule(toolName: string, targetKey: string): ToolRulePattern | undefined {
    for (const rule of this.rules) {
      if (rule.toolName !== "*" && rule.toolName !== toolName) {
        continue;
      }
      try {
        const glob = new Bun.Glob(rule.pattern);
        if (glob.match(targetKey)) {
          return rule;
        }
      } catch {
        if (targetKey.startsWith(rule.pattern.replace(/\*+$/, ""))) {
          return rule;
        }
      }
    }
    return undefined;
  }
}
