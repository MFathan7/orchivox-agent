import { planDirectory } from "../../tools/plan-directory";

export function planEnterReminder(directory = planDirectory()): string {
  return [
    "<system-reminder>",
    "You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:",
    directory,
    "",
    "Do not modify any other files or ask a subagent to do so.",
    "",
    "You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.",
    "</system-reminder>",
  ].join("\n");
}

export function planLeaveReminder(): string {
  return [
    "<system-reminder>",
    "You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply.",
    "Any Plan mode instructions from earlier in this conversation are no longer active.",
    "</system-reminder>",
  ].join("\n");
}
