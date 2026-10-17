import { z } from "zod";

import type { HookContext, HookOutcome, PluginDefinition } from "../../src/agent/hooks";

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "OpenAI style key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
];

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

function detectSecrets(text: string): string | undefined {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

async function auditDependencies(args: unknown): Promise<string> {
  const request = args as { projectRoot?: string };
  const root = (request.projectRoot ?? ".").replace(/\/+$/, "");
  const packageFile = Bun.file(`${root}/package.json`);
  if (!(await packageFile.exists())) throw new Error(`no package.json found under ${root}`);

  const manifest = JSON.parse(await packageFile.text()) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const findings: string[] = [];

  const lockfiles: string[] = [];
  for (const name of LOCKFILES) {
    if (await Bun.file(`${root}/${name}`).exists()) lockfiles.push(name);
  }
  if (lockfiles.length === 0) {
    findings.push("no lockfile found, installs are not reproducible");
  }

  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  for (const name of Object.keys(dependencies)) {
    if (name in devDependencies) findings.push(`"${name}" appears in both dependencies and devDependencies`);
  }

  const reportRange = (label: string, name: string, range: string): void => {
    const pinned = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(range);
    if (!pinned) findings.push(`"${label}${name}" is not pinned to an exact version (found "${range}")`);
  };
  for (const [name, range] of Object.entries(dependencies)) reportRange("", name, range);
  for (const [name, range] of Object.entries(devDependencies)) reportRange("devDependencies.", name, range);

  if (findings.length === 0) return `dependency audit clean (${Object.keys(dependencies).length + Object.keys(devDependencies).length} packages, lockfile: ${lockfiles.join(", ")})`;
  return [`dependency audit found ${findings.length} issue(s):`, ...findings.map((finding) => `- ${finding}`)].join("\n");
}

export const plugin: PluginDefinition = {
  name: "security-audit",
  version: "1.0.0",
  description: "Dependency hygiene checks and a guard against writing hardcoded secrets into code.",
  tools: [
    {
      name: "audit_dependencies",
      description:
        "Audit package.json dependencies: flags unpinned version ranges, dependencies listed twice, and a missing lockfile.",
      parameters: z.object({ projectRoot: z.string().default(".") }),
      readOnly: true,
      execute: (args) => auditDependencies(args),
    },
  ],
  hooks: {
    PreToolUse: [
      (context: HookContext): HookOutcome => {
        const serialized = JSON.stringify(context.args ?? {});
        const detected = detectSecrets(serialized);
        if (!detected) return { allowed: true };
        return {
          allowed: false,
          reason: `blocked by security_audit plugin: tool arguments look like a hardcoded secret (${detected})`,
        };
      },
    ],
  },
};

export default plugin;
