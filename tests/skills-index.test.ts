import { describe, expect, it } from "bun:test";

import {
  formatActiveSkills,
  formatAvailableSkills,
  formatSkillContent,
  matchSkillNames,
  parseSkillMentions,
  SKILL_GUIDANCE,
  type SkillDocument,
  type SkillRegistry,
} from "../src/agent/skills";

function document(
  name: string,
  description: string,
  extra: Partial<SkillDocument> = {},
): SkillDocument {
  return {
    name,
    description,
    path: `/tmp/${name}/SKILL.md`,
    scope: "project",
    body: "# Body\n\nInstructions.",
    autoinvoke: true,
    ...extra,
  };
}

describe("skill prompt formatting", () => {
  it("uses the opencode available skills XML", () => {
    const index = formatAvailableSkills([document("antislop", "Stop generic output.")]);
    expect(index).toContain(SKILL_GUIDANCE);
    expect(index).toContain("<available_skills>");
    expect(index).toContain("<id>antislop</id>");
    expect(index).toContain("<name>antislop</name>");
    expect(index).toContain("<description>Stop generic output.</description>");
  });

  it("omits skills that are not auto-invoked", () => {
    const index = formatAvailableSkills([
      document("hidden", "Not listed.", { autoinvoke: false }),
    ]);
    expect(index).not.toContain("<id>hidden</id>");
    expect(index).toContain("No skills are currently available.");
  });

  it("formats loaded skill content with its directory and files", async () => {
    const content = await formatSkillContent(
      document("pdf", "Read PDF files.", { path: "/tmp/pdf/SKILL.md" }),
    );
    expect(content).toContain('<skill_content name="pdf">');
    expect(content).toContain("# Skill: pdf");
    expect(content).toContain("Base directory for this skill: /tmp/pdf");
    expect(content).toContain("Relative paths in this skill");
    expect(content).toContain("<skill_files>");
    expect(content).toContain("<file>SKILL.md</file>");
    expect(content).toContain("</skill_content>");
  });

  it("keeps active skills in a durable prompt block", async () => {
    const active = await formatActiveSkills([
      document("pdf", "Read PDF files.", { body: "Use pdftotext." }),
    ]);
    expect(active).toContain("# Active skills");
    expect(active).toContain("- pdf: follow the loaded <skill_content>.");
    expect(active).toContain('<skill_content name="pdf">');
  });

  it("parses explicit $skill mentions", () => {
    const pdf = document("pdf", "Read PDF files.");
    const registry = {
      get: (name: string) => (name.toLowerCase() === "pdf" ? pdf : undefined),
    } as unknown as SkillRegistry;
    expect(parseSkillMentions("use $pdf and then $missing", registry).map((skill) => skill.name)).toEqual([
      "pdf",
    ]);
  });

  it("truncates the compact index and points to skill_list", () => {
    const documents = Array.from({ length: 20 }, (_, index) =>
      document(`skill-${index}`, "x".repeat(200)),
    );
    const index = formatAvailableSkills(documents, {
      compact: true,
      limit: 2,
      descriptionLimit: 20,
    });
    expect(index).not.toContain("<id>skill-2</id>");
    expect(index).toContain("More skills are available. Use skill_list to see all.");
    expect(index).toContain("...");
  });

  it("matches exact installed skill names in natural language", () => {
    const skills = [document("archify", "Architecture diagrams."), document("pdf", "Read PDFs.")];
    const registry = {
      listAvailableDocuments: () => skills,
    } as unknown as SkillRegistry;
    expect(
      matchSkillNames("Coba carikan informasi tentang archify", registry).map((skill) => skill.name),
    ).toEqual(["archify"]);
    expect(matchSkillNames("baca pdf ini", registry).map((skill) => skill.name)).toEqual(["pdf"]);
    expect(matchSkillNames("archifyx", registry)).toEqual([]);
  });
});
