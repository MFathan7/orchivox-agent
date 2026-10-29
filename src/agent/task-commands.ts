import { collectFileEvidence, collectProjectEvidence } from "./project-evidence";

export type TaskCommandName = "study" | "review";

export interface TaskCommandRequest {
  task: TaskCommandName;
  display: string;
  prompt: string;
  context: string;
}

export interface TaskCommandResult {
  request?: TaskCommandRequest;
  error?: string;
}

const PATH_LIKE = /[\\/]|^\.\.?$|\.[a-z0-9]{1,8}$/i;

export async function buildStudyCommand(root: string): Promise<TaskCommandRequest> {
  const evidence = await collectProjectEvidence(root);
  return {
    task: "study",
    display: "/study",
    prompt: "Study this project and report what exists.",
    context: evidence.text,
  };
}

export async function buildReviewCommand(
  root: string,
  args: string,
): Promise<TaskCommandResult> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "Usage: /review <file or question>" };
  }

  const [target, ...rest] = trimmed.split(/\s+/);
  const file = await collectFileEvidence(root, target);
  if (file) {
    const question = rest.join(" ").trim();
    return {
      request: {
        task: "review",
        display: `/review ${trimmed}`,
        prompt: question || `Review ${file.path} and report findings, behavior, and risks.`,
        context: file.text,
      },
    };
  }
  if (PATH_LIKE.test(target)) {
    return { error: `File not found: ${target}` };
  }

  const evidence = await collectProjectEvidence(root);
  return {
    request: {
      task: "review",
      display: `/review ${trimmed}`,
      prompt: trimmed,
      context: evidence.text,
    },
  };
}
