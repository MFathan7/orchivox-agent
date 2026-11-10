import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BenchmarkSample } from "./benchmark";

const relativeFile = z.string().min(1).refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).some((part) => part === ".." || part === ".git"), "Use a relative fixture path without .. or .git");
export const BenchmarkCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  mode: z.enum(["plan", "build"]),
  prompt: z.string().min(1),
  answer_includes: z.array(z.string().min(1)).default([]),
  verify: z.array(z.string().min(1)).optional(),
  allowed_changes: z.array(relativeFile).default([]),
}).superRefine((value, context) => {
  if (value.mode === "plan" && value.allowed_changes.length > 0) context.addIssue({ code: "custom", message: "Plan cases cannot allow file changes" });
  if (value.mode === "plan" && value.answer_includes.length === 0) context.addIssue({ code: "custom", message: "Plan cases need answer criteria" });
  if (value.mode === "build" && (!value.verify?.length || !value.allowed_changes.length)) context.addIssue({ code: "custom", message: "Build cases need a verifier and explicit file ownership" });
});
export const BenchmarkSuiteSchema = z.object({
  fixture: z.string().min(1),
  cases: z.array(BenchmarkCaseSchema).min(1),
}).refine((value) => new Set(value.cases.map((entry) => entry.id)).size === value.cases.length, "Case ids must be unique");
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export async function fingerprintWorkspace(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Benchmark fixtures must not contain symlinks");
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported fixture entry: ${entry.name}`);
      const stat = await lstat(path);
      files[relative(root, path).split(sep).join("/")] = `${stat.mode & 0o777}:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
    }
  };
  await walk(root);
  return files;
}

export function workspaceDigest(files: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

export async function copyBenchmarkFixture(fixture: string, target: string): Promise<Record<string, string>> {
  const before = await fingerprintWorkspace(fixture);
  await mkdir(target, { recursive: true });
  await cp(fixture, target, { recursive: true, filter: (path) => !relative(fixture, path).split(sep).includes(".git") });
  if (workspaceDigest(await fingerprintWorkspace(target)) !== workspaceDigest(before)) throw new Error("Fixture changed while it was being copied");
  return before;
}

export function benchmarkChecks(input: {
  task: BenchmarkCase; answer: string; finishReason: string;
  before: Record<string, string>; after: Record<string, string>; verifierPassed?: boolean;
}): NonNullable<BenchmarkSample["checks"]> {
  const changed = [...new Set([...Object.keys(input.before), ...Object.keys(input.after)])].filter((path) => input.before[path] !== input.after[path]);
  return [
    { name: "completed response", passed: input.finishReason === "stop" && input.answer.trim().length > 0 },
    ...input.task.answer_includes.map((text, index) => ({ name: `answer criterion ${index + 1}`, passed: input.answer.includes(text) })),
    { name: "file scope", passed: changed.every((path) => input.task.allowed_changes.includes(path)) },
    ...(input.task.mode === "build" ? [{ name: "behavior verifier", passed: input.verifierPassed === true }] : []),
  ];
}

export function comparableModels(samples: BenchmarkSample[]): boolean {
  const modelId = (model: string) => model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return samples.length > 0 && samples.every((sample) => modelId(sample.model) === modelId(samples[0].model)
    && sample.reasoning === samples[0].reasoning && sample.fixture_sha256 === samples[0].fixture_sha256);
}

export function fixturePath(suitePath: string, value: string): string {
  return resolve(suitePath, "..", value);
}
