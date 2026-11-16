import { dirname } from "node:path";

import type { SkillDiagnostic, SkillDocument } from "./skills";
import type { SkillDependency } from "./skill-metadata";

export interface SkillMcpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport?: string;
  url?: string;
  capabilities?: { resources: boolean; prompts: boolean };
}

export interface SkillDependencyEnvironment {
  registeredTools?: ReadonlySet<string>;
  availableTools?: ReadonlySet<string>;
  mcpServers?: readonly SkillMcpServerStatus[];
  findExecutable?: (name: string, cwd: string) => string | null | undefined;
  resourceExecutableCwd?: string;
}

export interface SkillDependencyCheck extends SkillDependency {
  status: "available" | "missing" | "restricted" | "unknown" | "mismatch";
  message: string;
}

export interface SkillDependencyReport {
  id: string;
  path: string;
  checks: SkillDependencyCheck[];
}

export function inspectSkillDependencies(document: SkillDocument, environment: SkillDependencyEnvironment = {}): SkillDependencyReport {
  const checks = (document.dependencies ?? []).map((dependency): SkillDependencyCheck => {
    const result = (status: SkillDependencyCheck["status"], message: string) => ({ ...dependency, status, message });
    if (dependency.type === "tool") {
      if (!environment.registeredTools || !environment.availableTools) return result("unknown", "Tool catalog was not provided.");
      if (!environment.registeredTools.has(dependency.value)) return result("missing", "Tool is not registered.");
      return environment.availableTools.has(dependency.value)
        ? result("available", "Present in this context's tool catalog; execution permissions still apply.")
        : result("restricted", "Registered, but absent from this mode, provider, or agent's tool catalog.");
    }
    if (dependency.type === "executable") {
      try {
        const find = environment.findExecutable ?? ((name, cwd) => Bun.which(name, { cwd }));
        return find(dependency.value, document.resource ? environment.resourceExecutableCwd ?? process.cwd() : dirname(document.path))
          ? result("available", "Executable found. Version, credentials, and execution permission were not checked.")
          : result("missing", "Executable was not found. Nothing was installed or executed.");
      } catch { return result("unknown", "Executable lookup failed; no command was run."); }
    }
    if (dependency.type !== "mcp") return result("unknown", "This dependency type is not supported; no setup was performed.");
    if (!environment.mcpServers) return result("unknown", "MCP connection status was not provided.");
    const server = environment.mcpServers.find((entry) => entry.name === dependency.value);
    if (!server) return result("missing", "MCP server is not configured under this name. Configure it explicitly in /mcp.");
    if (!server.enabled) return result("missing", "MCP server is configured but disabled.");
    if (!server.connected) return result("missing", "MCP server is configured but disconnected.");
    const transport = dependency.transport === "streamable_http" ? "http" : dependency.transport;
    if (transport && server.transport && transport !== server.transport) return result("mismatch", "Declared transport differs from this server's configuration.");
    if (dependency.url) {
      try {
        if (!server.url || new URL(dependency.url).href !== new URL(server.url).href) {
          return result("mismatch", "Declared endpoint differs from this server's configuration. No other server was selected.");
        }
      } catch { return result("unknown", "Could not compare the declared and configured endpoints."); }
    }
    const prefix = `mcp__${server.name}__`;
    const registered = [...(environment.registeredTools ?? [])].filter((name) => name.startsWith(prefix));
    if (server.capabilities?.resources && environment.registeredTools?.has("mcp_resources")) registered.push("mcp_resources");
    if (server.capabilities?.prompts && environment.registeredTools?.has("mcp_prompts")) registered.push("mcp_prompts");
    if (registered.length === 0) return result("unknown", "Server is connected, but no registered tool was observed. Resource capabilities were not checked.");
    if (!environment.availableTools) return result("unknown", "Server is connected, but this context's tool catalog was not provided.");
    if (environment.availableTools && !registered.some((name) => environment.availableTools!.has(name))) {
      return result("restricted", "Server is connected, but its tools are unavailable in this context.");
    }
    return result("available", "Server is connected and has an available MCP access tool. Permissions, scopes, and future requests still apply.");
  });
  return { id: document.id ?? document.name, path: document.path, checks };
}

export function dependencyDiagnostics(reports: readonly SkillDependencyReport[]): SkillDiagnostic[] {
  return reports.flatMap((report) => report.checks.filter((entry) => entry.status !== "available").map((entry) => ({
    kind: "dependency" as const, severity: "warning" as const, path: report.path,
    skillName: report.id, ids: [report.id], paths: [report.path],
    message: `${entry.type} ${entry.value}: ${entry.status}. ${entry.message}`,
  })));
}

export function dependencySummary(report: SkillDependencyReport): string[] {
  if (report.checks.length === 0) return [];
  return [
    "Dependency availability (snapshot; not permission, installation, or authentication):",
    ...report.checks.map((entry) => `- ${entry.type} ${entry.value}: ${entry.status}. ${entry.message}`),
  ];
}
