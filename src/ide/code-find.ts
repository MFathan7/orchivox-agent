import type { ToolOutput } from "../types/tool-output";
import { resolve } from "node:path";
import { z } from "zod";
import { CODE_SEARCH_SYSTEM } from "../agent/prompt/code-search";
import { currentTurnContext } from "../agent/turn-context";
import type { ProviderRouter } from "../provider/router";
import { ChatRequestSchema, type Usage } from "../types/schema";
import { collectFilesWithStatus } from "../tools/builtins";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import { workspaceRoot } from "../tools/workspace";

const Schema = z.object({
  query: z.string().min(1).max(2000).describe("Describe the behavior or responsibility whose implementation you need."),
  basePath: z.string().default("."), include: z.string().optional(),
  keywords: z.array(z.string().min(1).max(100)).max(12).default([]).describe("Optional literal identifiers likely to occur in the code."),
  method: z.enum(["semantic", "lexical"]).default("semantic").describe("Semantic uses one additional model request, counted in usage. Lexical uses local relevance scoring only."),
  limit: z.number().int().min(1).max(12).default(5),
  offset: z.number().int().min(0).max(300).default(0).describe("Skip this many locally ranked candidate files to inspect the next group."),
});
const tokens = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length > 2);

export function createCodeFindTool(registry: ToolRegistry, router: ProviderRouter): AgentTool<typeof Schema> {
  return {
    name: "code_find", description: "Locate implementation from a behavior description. Scopes live files, ranks candidates locally, then optionally asks a model to identify relevant ranges. Semantic mode makes one additional metered model request; lexical mode makes none. Results are leads, not proof of completeness. Known strings belong in grep_search; file names in glob_files.",
    parameters: Schema, readOnly: true, concurrency: "shared",
    async execute(args, context) {
      const root = workspaceRoot(process.cwd()), base = resolve(root, args.basePath);
      context?.signal?.throwIfAborted();
      const collected = await collectFilesWithStatus(base, args.include, 301, 5000, context?.signal);
      context?.signal?.throwIfAborted();
      const words = new Set(tokens(`${args.query} ${args.keywords.join(" ")}`));
      const candidates: Array<{ filePath: string; score: number; excerpt: string; lines: number }> = [];
      let denied = 0, oversized = 0, binary = 0, excerptsTruncated = 0;
      for (const path of collected.files.slice(0, 300)) {
        context?.signal?.throwIfAborted();
        const filePath = resolve(base, path), file = Bun.file(filePath);
        if (file.size > 1_000_000) { oversized++; continue; }
        const decision = await registry.authorize("read_file", { filePath }, context?.signal);
        if (!decision.allowed) { denied++; continue; }
        const bytes = await file.slice(0, 24_000).bytes();
        if (bytes.includes(0)) { binary++; continue; }
        if (file.size > bytes.length) excerptsTruncated++;
        const text = new TextDecoder().decode(bytes), lines = text.split("\n");
        const weights = new Map<string, number>();
        for (const word of tokens(text)) if (words.has(word)) weights.set(word, Math.min(5, (weights.get(word) ?? 0) + 1));
        const score = [...weights.values()].reduce((total, value) => total + value, 0) + tokens(path).filter((word) => words.has(word)).length * 5;
        let best = 0, bestScore = -1;
        for (let start = 0; start < lines.length; start += 20) {
          const score = tokens(lines.slice(start, start + 60).join("\n")).filter((word) => words.has(word)).length;
          if (score > bestScore) { best = start; bestScore = score; }
        }
        const excerpt = lines.slice(best, best + 60).map((line, i) => `${best + i + 1}: ${line.slice(0, 300)}`).join("\n").slice(0, 4500);
        candidates.push({ filePath, score, excerpt, lines: lines.length });
      }
      candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
      const pageSize = args.method === "lexical" ? args.limit : 16;
      const selected = candidates.slice(args.offset, args.offset + pageSize);
      const coverage = { scannedFiles: Math.min(collected.files.length, 300), deniedFiles: denied, oversizedFiles: oversized, binaryFiles: binary, excerptsTruncated, traversalTimedOut: collected.timedOut, fileLimitReached: collected.files.length > 300, candidateFiles: selected.length, rankedFiles: candidates.length, partial: true,
        nextOffset: args.offset + selected.length < candidates.length ? args.offset + selected.length : undefined,
        note: "Only bounded excerpts were inspected; no result does not establish absence. Narrow basePath/include or inspect the next candidate page." };
      const result = (method: string, matches: Array<{ filePath: string }>, error?: string): ToolOutput => ({
        status: error ? "error" : matches.length ? "partial" : "empty",
        text: JSON.stringify({ method, ...coverage, matches, ...(error ? { error } : {}) }),
        data: JSON.parse(JSON.stringify({ method, ...coverage, matches })),
        coverage: { scope: `First 300 files under ${base}; first 24000 bytes/file; bounded excerpts`, complete: false, returned: matches.length, total: candidates.length, unit: "candidate files" },
        truncation: { truncated: true, reason: "File, byte, excerpt and result limits apply; ranked candidates are not the full repository." },
        continuation: coverage.nextOffset === undefined ? { tool: "code_find", message: "Candidate pages exhausted. Narrow basePath/include or use grep_search for exact strings; this does not establish absence." } : { tool: "code_find", arguments: { ...args, offset: coverage.nextOffset }, message: "Inspect the next locally ranked candidate page; files may change between calls." },
        sources: matches.map((match) => ({ uri: match.filePath })), ...(error ? { code: "code_search_failed", reason: error } : {}),
      });
      if (args.method === "lexical" || !selected.length) return result("lexical", selected.filter((candidate) => candidate.score > 0));
      const mode = currentTurnContext()?.mode ?? "build";
      const ref = router.getRole("fast") ?? router.getModeModel(mode);
      if (!ref) throw new Error("No model route for semantic code search. Configure a model or use method: lexical.");
      const provider = router.provider(ref.provider, ref.model);
      const request = ChatRequestSchema.parse({ model: ref.model, system: CODE_SEARCH_SYSTEM, tools: [], tool_choice: "none", max_tokens: 1500,
        messages: [{ id: "code-search", role: "user", content: [{ type: "text", text: JSON.stringify({ query: args.query, limit: args.limit, candidates: selected.map((candidate, index) => ({ index, ...candidate })) }) }] }] });
      let output = "";
      const startedAt = Date.now();
      const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      let usageReported = false, retries = 0, retryDelayMs = 0;
      try {
        context?.signal?.throwIfAborted();
        try {
          for await (const event of provider.streamChat(request, context?.signal)) {
            if (event.type === "usage") {
              usageReported = true;
              usage.prompt_tokens += event.prompt_tokens; usage.completion_tokens += event.completion_tokens;
              usage.cache_read_input_tokens += event.cache_read_input_tokens; usage.cache_creation_input_tokens += event.cache_creation_input_tokens;
              currentTurnContext()?.onToolUsage?.(event);
            } else if (event.type === "token") output += event.text;
            else if (event.type === "error") throw new Error(event.message);
            else if (event.type === "retry_scheduled") { retries++; retryDelayMs += event.delay_ms; }
            if (output.length > 30_000) throw new Error("Code search model returned too much output.");
          }
        } finally {
          if (!usageReported) currentTurnContext()?.onToolUsageMissing?.();
          currentTurnContext()?.onToolModelRequest?.({ ...ref, startedAt, durationMs: Date.now() - startedAt, usage, retries, retryDelayMs });
        }
        context?.signal?.throwIfAborted();
        const ranked = z.array(z.object({ index: z.number().int().nonnegative(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), reason: z.string().max(1000) })).max(args.limit).parse(JSON.parse(output));
        const matches = ranked.map((hit) => {
          const candidate = selected[hit.index];
          if (!candidate || hit.endLine < hit.startLine || hit.endLine > candidate.lines) throw new Error("Code search model returned an invalid location.");
          const visible = new Set(candidate.excerpt.split("\n").map((line) => Number(line.slice(0, line.indexOf(":")))));
          if (!visible.has(hit.startLine) || !visible.has(hit.endLine)) throw new Error("Code search model referenced code outside its excerpt.");
          return { filePath: candidate.filePath, startLine: hit.startLine, endLine: hit.endLine, reason: hit.reason };
        });
        return result("semantic", matches);
      } catch (error) {
        context?.signal?.throwIfAborted();
        return result("semantic", [], error instanceof Error ? error.message : String(error));
      }
    },
  };
}
