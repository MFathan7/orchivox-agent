import { afterEach, describe, expect, it } from "bun:test";
import React from "react";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { parseSkillDocument, SkillRegistry } from "../src/agent/skills";
import { SpecialistAgentRegistry } from "../src/agent/specialist-agents";
import {
  detectTriggerContext,
  queryAutocomplete,
  resetAutocompleteCaches,
} from "../src/tui/autocomplete";
import { SkillsModal } from "../src/tui/skills-modal";
import { ToolRegistry } from "../src/tools/registry";
import { getTheme } from "../src/tui/theme";

const createdDirs: string[] = [];

async function makeSkillRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orchivox-skills-"));
  createdDirs.push(dir);
  await mkdir(join(dir, ".agent", "skills", "pdf"), { recursive: true });
  await writeFile(
    join(dir, ".agent", "skills", "pdf", "SKILL.md"),
    [
      "---",
      "name: pdf",
      "description: Extract text and tables from PDF files.",
      "when_to_use: When the user attaches a PDF.",
      "allowed_tools:",
      "  - read_file",
      "  - shell",
      "---",
      "",
      "# PDF workflow",
      "",
      "1. Inspect the file.",
      "2. Extract the text.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, ".agent", "skills", "notes.md"),
    ["# Notes", "", "Summarize meeting notes into decisions."].join("\n"),
  );
  return dir;
}

afterEach(async () => {
  resetAutocompleteCaches();
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Skill documents", () => {
  it("parses yaml frontmatter and falls back to the heading", () => {
    const withMeta = parseSkillDocument(
      ["---", "name: review", "description: Review a diff.", "---", "", "# Body", "", "Do the review."].join("\n"),
      "/tmp/review/SKILL.md",
      "review",
    );
    expect(withMeta.name).toBe("review");
    expect(withMeta.description).toBe("Review a diff.");
    expect(withMeta.body).toContain("Do the review.");

    const withoutMeta = parseSkillDocument("# Deploy\n\nShip it safely.", "/tmp/deploy.md", "deploy");
    expect(withoutMeta.name).toBe("Deploy");
    expect(withoutMeta.description).toBe("Ship it safely.");
  });
});

describe("Skill registry", () => {
  it("discovers directory and flat skills, then builds a compact index", async () => {
    const repo = await makeSkillRepo();
    const registry = new SkillRegistry({ repoRoot: repo, includeGlobalDirectories: false });
    const documents = await registry.load(true);

    expect(documents.map((document) => document.name).sort()).toEqual(["Notes", "pdf"]);
    expect(registry.get("PDF")?.description).toContain("PDF files");

    const index = registry.buildIndexPrompt();
    expect(index).toContain("<available_skills>");
    expect(index).toContain("<id>pdf</id>");
    expect(index).toContain("<description>Extract text and tables from PDF files.</description>");
    expect(index).toContain("<id>Notes</id>");
    expect(index).toContain("<description>Summarize meeting notes into decisions.</description>");
    expect(index).not.toContain("Inspect the file");
  });

  it("scans fallback skill directories and prefers the .agent copy", async () => {
    const repo = await makeSkillRepo();
    await mkdir(join(repo, ".claude", "skills", "pdf"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "skills", "pdf", "SKILL.md"),
      ["---", "name: pdf", "description: Claude copy", "---", "", "# Other", ""].join("\n"),
    );
    await mkdir(join(repo, ".claude", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "skills", "deploy", "SKILL.md"),
      ["---", "name: deploy", "description: Deploy it safely.", "---", "", "# Deploy", ""].join("\n"),
    );

    const registry = new SkillRegistry({
      repoRoot: repo,
      includeGlobalDirectories: false,
      extraDirectories: [join(repo, ".claude", "skills")],
    });
    await registry.load(true);

    expect(registry.get("pdf")?.description).toContain("PDF files");
    expect(registry.get("deploy")?.description).toBe("Deploy it safely.");
  });

  it("loads a skill on demand through the tool", async () => {    const repo = await makeSkillRepo();
    const registry = new SkillRegistry({ repoRoot: repo, includeGlobalDirectories: false });
    await registry.load(true);

    const tools = new ToolRegistry();
    registry.registerTools(tools);

    const loaded = await tools.run({ id: "t1", name: "skill", arguments: { id: "pdf" } }, "build");
    expect(loaded.is_error).toBe(false);
    expect(String(loaded.content)).toContain("# Skill: pdf");
    expect(String(loaded.content)).toContain("Inspect the file.");

    const missing = await tools.run({ id: "t2", name: "skill", arguments: { id: "nope" } }, "build");
    expect(String(missing.content)).toContain("Available skills");

    const list = await tools.run({ id: "t3", name: "skill_list", arguments: {} }, "plan");
    expect(list.is_error).toBe(false);
    expect(String(list.content)).toContain("pdf");
  });

  it("returns an honest empty index when no skills exist", async () => {
    const repo = await mkdtemp(join(tmpdir(), "orchivox-empty-skills-"));
    createdDirs.push(repo);
    const registry = new SkillRegistry({ repoRoot: repo, includeGlobalDirectories: false });
    expect(await registry.load(true)).toEqual([]);
    expect(registry.buildIndexPrompt()).toContain("No skills are currently available.");
  });
});

describe("Specialist tool filtering", () => {
  it("keeps skill tools and only read-only tools for a read-only specialist", () => {
    const registry = new SpecialistAgentRegistry({ repoRoot: "/tmp/orchivox-test" });
    const profile = {
      name: "oracle",
      description: "Read-only analyst",
      systemPrompt: "analyze only",
      readOnly: true,
      allowedTools: ["read_file", "skill"],
      source: "custom" as const,
    };
    const definitions = ["read_file", "hash_edit", "skill", "skill_list", "task_create"].map((name) => ({
      name,
      description: name,
      parameters: {},
      strict: false,
      metadata: {},
    }));
    const readOnlyNames = new Set(["read_file", "skill", "skill_list", "task_list"]);

    const filtered = registry.filterTools(profile, definitions, readOnlyNames).map((tool) => tool.name);
    expect(filtered).toEqual(["read_file", "skill", "skill_list"]);
  });
});

describe("Skill autocomplete", () => {  it("detects the $ trigger and lists installed skills", async () => {
    const repo = await makeSkillRepo();
    const context = detectTriggerContext("summarize $pd", "summarize $pd".length);
    expect(context?.trigger).toBe("skill");
    expect(context?.query).toBe("pd");

    const result = await queryAutocomplete("summarize $pd", "summarize $pd".length, repo);
    expect(result?.context.trigger).toBe("skill");
    expect(result?.items.some((item) => item.label === "pdf")).toBe(true);
  });
});

describe("Skills modal", () => {
  it("renders installed skills and the selected preview", async () => {
    const repo = await makeSkillRepo();
    const registry = new SkillRegistry({ repoRoot: repo, includeGlobalDirectories: false });
    const skills = await registry.load(true);

    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const instance = render(
      React.createElement(SkillsModal, {
        skills,
        width: 100,
        theme: getTheme("tokyonight"),
        onClose: () => undefined,
      }),
      { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    expect(output).toContain("Skills (2)");
    expect(output).toContain("pdf");
    expect(output).toContain("Summarize meeting notes");
    instance.unmount();
  });
});
