import { ChatRequestSchema } from "../types/schema";
import { runGit } from "../vcs/git";
import type { ProviderRouter } from "../provider/router";

export const ADVISOR_NOTE_PREFIX = "[ADVISOR NOTE]:";

const ADVISOR_PROMPT = [
  "You are a senior code reviewer working alongside a coding agent.",
  "Review the git diff for bugs, security gaps, and missing edge-case handling.",
  "Reply with at most 5 short bullet findings, each starting with '- '.",
  "Reply with exactly LGTM when there are no issues.",
].join(" ");

export interface AdvisorReviewerOptions {
  router: ProviderRouter;
  repoRoot?: string;
  maxDiffChars?: number;
}

export class AdvisorReviewer {
  private readonly router: ProviderRouter;
  private readonly root: string;
  private readonly maxDiffChars: number;
  private note: string | undefined;
  private running = false;

  constructor(options: AdvisorReviewerOptions) {
    this.router = options.router;
    this.root = options.repoRoot ?? globalThis.process.cwd();
    this.maxDiffChars = options.maxDiffChars ?? 40_000;
  }

  get isRunning(): boolean {
    return this.running;
  }

  scheduleReview(): void {
    if (this.running) return;
    this.running = true;
    void this.reviewLatestDiff()
      .then((note) => {
        if (note) this.note = note;
      })
      .catch(() => {
        // advisor failures never interrupt the main agent
      })
      .finally(() => {
        this.running = false;
      });
  }

  consumeNote(): string | undefined {
    const note = this.note;
    this.note = undefined;
    return note;
  }

  peekNote(): string | undefined {
    return this.note;
  }

  async reviewLatestDiff(): Promise<string | undefined> {
    const diff = await this.readDiff();
    if (diff.trim().length === 0) return undefined;

    const request = ChatRequestSchema.parse({
      system: ADVISOR_PROMPT,
      messages: [
        {
          id: "advisor-diff",
          role: "user",
          content: [{ type: "text", text: `Review this git diff:\n${truncate(diff, this.maxDiffChars)}` }],
        },
      ],
      max_tokens: 800,
    });

    let text = "";
    for await (const event of this.router.get("advisor").streamChat(request)) {
      if (event.type === "token") text += event.text;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 || /^lgtm$/i.test(trimmed)) return undefined;
    return `${ADVISOR_NOTE_PREFIX} ${trimmed}`;
  }

  private async readDiff(): Promise<string> {
    const tracked = await runGit(this.root, ["diff", "HEAD"], { allowFailure: true });
    if (tracked.exitCode === 0) return tracked.stdout;
    return (await runGit(this.root, ["diff"], { allowFailure: true })).stdout;
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... diff truncated after ${limit} characters`;
}
