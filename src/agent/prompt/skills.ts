export interface UnavailableSkill {
  id: string;
  reason: "disabled" | "invalid metadata";
}

export const SKILL_OUTPUT_CORRECTION = [
  "The previous response copied raw skill instructions or host protocol wrappers.",
  "Answer the user's request using the project evidence and tool results already present.",
  "Do not copy raw skill bodies, sampled file listings, or host XML wrappers into the answer.",
  "Keep reports and explanations requested by the user or required by a skill.",
];

export function skillAvailabilityHint(skills: readonly UnavailableSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "# Skill availability",
    "These skills are unavailable under their current metadata:",
    ...skills.map((skill) => `- ${JSON.stringify(skill.id)}: ${skill.reason}.`),
    "Previously loaded content does not reactivate these skills. Inspect /skills for the current metadata and errors.",
  ].join("\n");
}
