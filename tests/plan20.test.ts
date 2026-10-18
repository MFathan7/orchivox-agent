import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AdvisorNoteEventSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ApprovalRequiredEventSchema,
  BgProcessUpdateEventSchema,
  CustomCommandSchema,
  MultiHunkEditSchema,
  ReasoningEffortSchema,
  SpecialistAgentProfileSchema,
  StreamEventSchema,
} from "../src/types/schema";
import { AgentOrchestrator } from "../src/agent/orchestrator";
import { ProviderRouter } from "../src/provider/router";
import { WorktreeManager } from "../src/vcs/worktree";
import { SnapshotManager } from "../src/vcs/snapshot";
import { RulesLoader } from "../src/memory/rules-loader";
import { MemoryDatabase } from "../src/memory/sqlite";
import { GranularPermissionEngine } from "../src/agent/permissions";
import type { AppConfig } from "../config/loader";

const TEST_DIR = resolve(process.cwd(), ".agent/test-plan20");

async function setupTestDir(): Promise<void> {
  if (existsSync(TEST_DIR)) {
    await rm(TEST_DIR, { recursive: true, force: true });
  }
  await mkdir(TEST_DIR, { recursive: true });
}

function createDummyConfig(): AppConfig {
  return {
    version: 1,
    models: {
      providers: {
        dummy: {
          kind: "openai",
          api_key: "dummy-key",
          base_url: "http://localhost:9999",
          models: {
            "dummy-main": { id: "dummy-main", context_window: 128000, max_output: 4096 },
            "dummy-fast": { id: "dummy-fast", context_window: 128000, max_output: 4096 },
            "dummy-advisor": { id: "dummy-advisor", context_window: 128000, max_output: 4096 },
          },
        },
      },
      roles: {
        main: { provider: "dummy", model: "dummy-main" },
        fast: { provider: "dummy", model: "dummy-fast" },
        advisor: { provider: "dummy", model: "dummy-advisor" },
      },
    },
    system_prompt: "You are Orchivox test agent.",
    permissions: {
      default_action: "ask",
      rules: [],
    },
    inbound_server: {
      port: 8080,
    },
    mcp: {
      servers: {},
    },
    lsp: {
      servers: {},
    },
    hooks: {},
  };
}

describe("Master Integration Phase 2 - Types & Schema", () => {
  it("validates ReasoningEffortSchema levels correctly", () => {
    expect(ReasoningEffortSchema.parse("off")).toBe("off");
    expect(ReasoningEffortSchema.parse("low")).toBe("low");
    expect(ReasoningEffortSchema.parse("medium")).toBe("medium");
    expect(ReasoningEffortSchema.parse("high")).toBe("high");
    expect(ReasoningEffortSchema.parse("max")).toBe("max");
    expect(() => ReasoningEffortSchema.parse("ultra")).toThrow();
  });

  it("validates ApprovalRequest and ApprovalDecision schemas", () => {
    const request = ApprovalRequestSchema.parse({
      id: "req-1",
      toolCallId: "call-1",
      toolName: "hash_edit",
      args: { filePath: "src/main.ts", newContent: "console.log(1);" },
      mode: "build",
      readOnly: false,
      filePath: "src/main.ts",
      diffPreview: {
        filePath: "src/main.ts",
        oldText: "",
        newText: "console.log(1);",
      },
      shellDetails: undefined,
    });
    expect(request.toolName).toBe("hash_edit");
    expect(request.diffPreview?.newText).toBe("console.log(1);");

    const decision = ApprovalDecisionSchema.parse({
      approved: true,
      choice: "approve_once",
      feedback: "proceed with caution",
    });
    expect(decision.approved).toBe(true);
    expect(decision.choice).toBe("approve_once");
  });

  it("validates MultiHunkEditSchema for hash_edit v2", () => {
    const multiEdit = MultiHunkEditSchema.parse({
      filePath: "src/app.ts",
      edits: [
        { startAnchor: "10:abc", endAnchor: "12:def", newContent: "let a = 1;" },
        { startAnchor: "25:123", endAnchor: "26:456", newContent: "let b = 2;" },
      ],
    });
    expect(multiEdit.filePath).toBe("src/app.ts");
    expect(multiEdit.edits?.length).toBe(2);
  });

  it("validates SpecialistAgentProfileSchema and CustomCommandSchema", () => {
    const profile = SpecialistAgentProfileSchema.parse({
      name: "oracle",
      description: "Architecture advisor",
      systemPrompt: "You are the Oracle.",
      modelRole: "advisor_model",
      thinkingBudget: 8192,
      readOnlyOnly: true,
    });
    expect(profile.name).toBe("oracle");
    expect(profile.thinkingBudget).toBe(8192);

    const command = CustomCommandSchema.parse({
      name: "review",
      description: "Review git changes",
      template: "Please review: $ARGUMENTS",
      argumentCount: 1,
    });
    expect(command.name).toBe("review");
  });

  it("validates new StreamEvent types (approval_required, advisor_note, bg_process_update)", () => {
    const approvalEvent = StreamEventSchema.parse({
      type: "approval_required",
      request: {
        id: "req-123",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "npm test" },
        mode: "build",
        readOnly: false,
      },
    });
    expect(approvalEvent.type).toBe("approval_required");

    const advisorEvent = StreamEventSchema.parse({
      type: "advisor_note",
      note: "Consider checking error handling in auth loop.",
      severity: "warning",
    });
    expect(advisorEvent.type).toBe("advisor_note");

    const bgEvent = StreamEventSchema.parse({
      type: "bg_process_update",
      processId: "bg-server-1",
      status: "running",
      listeningUrls: ["http://localhost:3000"],
      recentLogLine: "Server ready",
    });
    expect(bgEvent.type).toBe("bg_process_update");
  });
});

describe("Master Integration Phase 2 - Agent Orchestrator Tool Registry", () => {
  it("registers all Phase 1 and Phase 2 tools comprehensively into ToolRegistry", async () => {
    await setupTestDir();
    const config = createDummyConfig();
    const router = new ProviderRouter(config);
    const database = new MemoryDatabase(resolve(TEST_DIR, "memory.db"));
    const worktrees = new WorktreeManager({ repoRoot: TEST_DIR });
    const snapshots = new SnapshotManager({ repoRoot: TEST_DIR });
    const rules = new RulesLoader({ rootPath: TEST_DIR });
    const permissions = new GranularPermissionEngine({ repoRoot: TEST_DIR });

    const orchestrator = new AgentOrchestrator({
      router,
      worktrees,
      snapshots,
      rules,
      database,
      config,
      permissions,
      repoRoot: TEST_DIR,
    });

    await orchestrator.initialize();

    const expectedTools = [
      // File editing & lifecycle tools
      "read_file",
      "hash_edit",
      "create_file",
      "delete_file",
      "move_file",
      "apply_unified_patch",
      // Search & shell
      "glob_files",
      "grep_search",
      "diff_view",
      "json_query",
      "bash",
      // AST tools
      "read_skeleton",
      "repo_map",
      // Diagnostics
      "diagnostics_check",
      // Background process manager
      "bg_start",
      "bg_logs",
      "bg_list",
      "bg_stop",
      // Multimodal vision
      "inspect_image",
      // Code intelligence & dependency graph
      "repo_architecture_map",
      "lsp_workspace_symbols",
      "lsp_hover_type",
      "symbol_impact_analysis",
      // Tasks & Subagents
      "todo_read",
      "todo_write",
      "spawn_subagents",
      "task_create",
      "task_list",
      "task_dispatch",
      "task_cancel",
      "task_merge",
      "task_wait",
      // Skills
      "skill",
      "skill_list",
      // Hindsight memory
      "remember_insight",
      "recall_insights",
    ];

    for (const toolName of expectedTools) {
      expect(orchestrator.registry.has(toolName)).toBe(true);
    }

    await orchestrator.bgProcesses.stopAll();
    database.close();
  });

  it("handles custom command expansion and specialist agent resolution", async () => {
    await setupTestDir();
    const config = createDummyConfig();
    const router = new ProviderRouter(config);
    const database = new MemoryDatabase(resolve(TEST_DIR, "memory.db"));
    const worktrees = new WorktreeManager({ repoRoot: TEST_DIR });
    const snapshots = new SnapshotManager({ repoRoot: TEST_DIR });
    const rules = new RulesLoader({ rootPath: TEST_DIR });

    const orchestrator = new AgentOrchestrator({
      router,
      worktrees,
      snapshots,
      rules,
      database,
      config,
      repoRoot: TEST_DIR,
    });

    await orchestrator.initialize();

    // Verify default custom commands exist
    const reviewCmd = await orchestrator.customCommands.getCommand("review");
    expect(reviewCmd).toBeDefined();
    expect(reviewCmd?.frontmatter.agent).toBe("oracle");

    // Verify specialist agents exist
    const oracleAgent = await orchestrator.specialistAgents.getAgent("oracle");
    expect(oracleAgent).toBeDefined();
    expect(oracleAgent?.readOnly).toBe(true);

    database.close();
  });
});
