import { isAbsolute, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { applyPatch } from "diff";

import type { AgentMode, ToolCall } from "../types/schema";
import { readText, splitLines } from "../tools/hashline-edit";
import { modeContract } from "./modes";

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
  alwaysAllowLabel?: string;
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

const SHELL_TOOL_NAMES = new Set(["bash", "bg_start"]);
export const EDIT_TOOL_NAMES = new Set([
  "hash_edit",
  "write_file",
  "create_file",
  "delete_file",
  "move_file",
  "apply_unified_patch",
]);
const MULTI_WORD_COMMANDS = new Set([
  "git",
  "npm",
  "bun",
  "pnpm",
  "yarn",
  "docker",
  "kubectl",
  "cargo",
  "go",
  "pip",
  "uv",
  "deno",
]);
const SHELL_WRAPPER_COMMANDS = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "xargs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "node",
  "python",
  "python3",
  "bunx",
  "npx",
]);

export interface PermissionConfigRule {
  action: string;
  resource: string;
  effect: PermissionAction;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      if (current.trim().length > 0) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) segments.push(current.trim());
  return segments;
}

function tokenizeShellSegment(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function commandSignatureForSegment(segment: string): string | undefined {
  const tokens = tokenizeShellSegment(segment);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  if (index >= tokens.length) return undefined;

  const rawName = unquote(tokens[index]);
  if (!rawName) return undefined;
  const name = rawName.split("/").pop() ?? rawName;
  if (SHELL_WRAPPER_COMMANDS.has(name)) return undefined;

  if (MULTI_WORD_COMMANDS.has(name)) {
    const second = tokens[index + 1] ? unquote(tokens[index + 1]) : "";
    if (second && !second.startsWith("-") && !/^[<>=]/.test(second)) {
      return `${name} ${second}`;
    }
  }
  return name;
}

export function shellCommandSignatures(command: string): string[] | undefined {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return undefined;
  const signatures = segments.map(commandSignatureForSegment);
  if (signatures.some((signature) => signature === undefined)) return undefined;
  return signatures as string[];
}

export function isSimpleShellCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  if (segments.length !== 1) return false;
  const segment = segments[0];
  if (/[<>`]|\$\(/.test(segment)) return false;
  return commandSignatureForSegment(segment) !== undefined;
}

function isInsideWorkspace(repoRoot: string, value: string): boolean {
  const resolved = resolve(repoRoot, value);
  const rel = relative(repoRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shellPathsOutsideWorkspace(
  command: string,
  cwd: string,
  repoRoot: string,
): boolean {
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeShellSegment(segment);
    for (let index = 0; index < tokens.length; index += 1) {
      let token = unquote(tokens[index]);
      if (!token || token === "-" || token.includes("://")) continue;
      if (token.startsWith("-") && !token.includes("=")) continue;
      if (token.startsWith("-") && token.includes("=")) {
        token = token.slice(token.indexOf("=") + 1);
      }
      if (token.startsWith("~")) return true;
      if (!token.startsWith(".") && !token.startsWith("/") && !token.includes("/")) continue;
      if (!isInsideWorkspace(repoRoot, resolve(cwd, token))) return true;
    }
  }
  return false;
}

export function permissionRulesFromConfig(
  rules: readonly PermissionConfigRule[],
): ToolRulePattern[] {
  const rulesForAction = (action: string): string[] => {
    if (action === "shell") return [...SHELL_TOOL_NAMES];
    if (action === "edit") return [...EDIT_TOOL_NAMES];
    if (action === "read") return ["read_file"];
    if (action === "*") return ["*"];
    return [action];
  };

  return rules.flatMap((rule) =>
    rulesForAction(rule.action).map((toolName) => ({
      raw: `${toolName}(${rule.resource}) -> ${rule.effect}`,
      toolName,
      pattern: rule.resource,
      action: rule.effect,
    })),
  );
}

/** Matches a shell command against a rule pattern where "*" crosses any character. */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "" || trimmed === "*") return true;
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "s").test(command.trim());
  } catch {
    return false;
  }
}

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

const PLAN_READ_ONLY_COMMANDS = new Set([
  "date",
  "pwd",
  "whoami",
  "id",
  "uname",
  "hostname",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "stat",
  "file",
  "du",
  "df",
  "which",
  "type",
]);

const PLAN_READ_ONLY_GIT_COMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
]);

const SHELL_CONTROL_PATTERN = /[><|;&`\n]|\$\(/;

/**
 * Returns true for shell commands that only inspect the workspace or system.
 * Plan mode uses this to allow read-only commands while still blocking writes.
 */
export function isPlanReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL_PATTERN.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const name = tokens[0];
  if (!name) return false;

  if (name === "date") {
    return !tokens.some((token) => token === "-s" || token === "--set");
  }
  if (name === "hostname") {
    return tokens.length === 1;
  }
  if (name === "git") {
    const sub = tokens[1];
    return Boolean(sub && PLAN_READ_ONLY_GIT_COMMANDS.has(sub));
  }
  if (name === "find") {
    return !tokens.some((token) =>
      ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf"].includes(token),
    );
  }

  return PLAN_READ_ONLY_COMMANDS.has(name);
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

  isSessionAllowedFor(
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    const keys = this.sessionKeysFor(toolName, args);
    return keys.length > 0 && keys.every((key) => this.isSessionAllowed(toolName, key));
  }

  allowInSessionFor(toolName: string, args: Record<string, unknown>): void {
    for (const key of this.sessionKeysFor(toolName, args)) {
      this.allowInSession(toolName, key);
    }
  }

  private sessionKeysFor(
    toolName: string,
    args: Record<string, unknown>,
  ): string[] {
    if (SHELL_TOOL_NAMES.has(toolName) && typeof args.command === "string") {
      return shellCommandSignatures(args.command) ?? [];
    }
    if (EDIT_TOOL_NAMES.has(toolName) && typeof args.filePath === "string") {
      const filePath = args.filePath.trim();
      return isInsideWorkspace(this.repoRoot, resolve(this.repoRoot, filePath))
        ? ["workspace"]
        : [filePath];
    }
    if (typeof args.filePath === "string") return [args.filePath.trim()];
    return ["*"];
  }

  private alwaysAllowLabel(
    toolName: string,
    args: Record<string, unknown>,
  ): string | undefined {
    if (SHELL_TOOL_NAMES.has(toolName) && typeof args.command === "string") {
      const signatures = shellCommandSignatures(args.command);
      if (!signatures || signatures.length === 0) return undefined;
      return `${signatures.join(" + ")} in this workspace`;
    }
    if (EDIT_TOOL_NAMES.has(toolName)) {
      const filePath = typeof args.filePath === "string" ? args.filePath : undefined;
      if (filePath && isInsideWorkspace(this.repoRoot, resolve(this.repoRoot, filePath))) {
        return "edits in this workspace";
      }
      return filePath ? `edits to ${filePath}` : "edits";
    }
    return "this tool";
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
    const cwd = typeof args.cwd === "string" ? args.cwd : this.repoRoot;
    const shellRisk =
      SHELL_TOOL_NAMES.has(tool.name) && typeof args.command === "string"
        ? evaluateShellRisk(args.command, cwd)
        : undefined;

    if (mode === "plan") {
      if (tool.readOnly) {
        return { allowed: true };
      }
      if (tool.name === "bash" && typeof args.command === "string") {
        if (isPlanReadOnlyShellCommand(args.command) && shellRisk?.riskLevel === "low") {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `PLAN mode allows only read-only shell commands. ${shellRisk?.warning ?? "Use a safe inspection command or switch to build mode."}`,
        };
      }
      return {
        allowed: false,
        reason: `Tool "${tool.name}" modifies files or state, and PLAN mode only allows read-only tools.`,
      };
    }

    if (shellRisk?.riskLevel === "critical") {
      return {
        allowed: false,
        reason: `Fatal command "${shellRisk.command}" automatically denied in ${mode.toUpperCase()} mode: ${shellRisk.warning}`,
      };
    }

    const targetKey = this.extractTargetKey(tool.name, args);
    const matchedRule = this.matchConfigRule(tool.name, targetKey);
    let forceApproval = false;
    if (matchedRule) {
      if (matchedRule.action === "allow") return { allowed: true };
      if (matchedRule.action === "deny") {
        return {
          allowed: false,
          reason: `Denied by configuration rule: ${matchedRule.raw}`,
        };
      }
      forceApproval = true;
    }

    const sessionAllowed =
      this.isSessionAllowedFor(tool.name, args) &&
      !(
        SHELL_TOOL_NAMES.has(tool.name) &&
        typeof args.command === "string" &&
        shellPathsOutsideWorkspace(args.command, cwd, this.repoRoot)
      );
    if (sessionAllowed) {
      return { allowed: true };
    }

    if (modeContract(mode).fullAccess && !forceApproval) {
      // Build and ultrawork run without approval prompts. Configuration deny
      // rules and the critical shell guard above still apply.
      return { allowed: true };
    }

    if (tool.readOnly && !forceApproval) {
      return { allowed: true };
    }

    if (!forceApproval) {
      if (EDIT_TOOL_NAMES.has(tool.name) && typeof args.filePath === "string") {
        if (isInsideWorkspace(this.repoRoot, resolve(cwd, args.filePath))) {
          return { allowed: true };
        }
      }
      if (
        SHELL_TOOL_NAMES.has(tool.name) &&
        typeof args.command === "string" &&
        shellRisk &&
        (shellRisk.riskLevel === "low" || shellRisk.riskLevel === "medium") &&
        isSimpleShellCommand(args.command) &&
        !shellPathsOutsideWorkspace(args.command, cwd, this.repoRoot)
      ) {
        return { allowed: true };
      }
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
      alwaysAllowLabel: this.alwaysAllowLabel(tool.name, args),
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

  async requestApproval(
    request: ApprovalRequest,
    allowSession = true,
  ): Promise<ApprovalDecision> {
    const cwd =
      typeof request.args.cwd === "string" ? request.args.cwd : this.repoRoot;
    const outsideWorkspace =
      SHELL_TOOL_NAMES.has(request.toolName) &&
      typeof request.args.command === "string" &&
      shellPathsOutsideWorkspace(request.args.command, cwd, this.repoRoot);
    if (
      allowSession &&
      !outsideWorkspace &&
      this.isSessionAllowedFor(request.toolName, request.args)
    ) {
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
      this.allowInSessionFor(request.toolName, request.args);
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
    const shellTarget = SHELL_TOOL_NAMES.has(toolName) || toolName === "bg_start";
    for (let index = this.rules.length - 1; index >= 0; index -= 1) {
      const rule = this.rules[index];
      if (rule.toolName !== "*" && rule.toolName !== toolName) {
        continue;
      }
      if (shellTarget) {
        // Shell targets are commands, not paths: a path glob would refuse to
        // let "*" cross a slash, so "rm *" could never match "rm src/foo.ts".
        if (matchCommandPattern(rule.pattern, targetKey)) return rule;
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
