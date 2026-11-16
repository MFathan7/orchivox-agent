import { InputQueue, type InputQueueStore, type QueuedInput } from "../agent/input-queue";
import { InputRunCancelled, type InputRunContext, type InputRunResult } from "../agent/run-lifecycle";

export type InputAction =
  | { kind: "command"; command: string; args?: string; raw?: string }
  | { kind: "submit"; text: string; ultrawork: boolean };

export type InputRoute = "work" | "control" | "side";

export interface SubmittedInput<Attachment> {
  text: string;
  action: InputAction;
  attachments?: Attachment[];
  agent?: string;
  task?: "study" | "review";
  context?: string;
}

const CONTROL_COMMANDS = new Set([
  "/help", "/plan", "/build", "/ultrawork", "/mode", "/theme",
  "/reasoning", "/palette", "/settings", "/models", "/connect",
  "/sessions", "/fork", "/timeline", "/hub", "/tasks", "/skills",
  "/about", "/doctor", "/stats", "/turn-report", "/debug", "/plugins",
  "/collab", "/new", "/clear", "/exit", "/quit", "/queue",
  "/mcp",
]);

export function inputRoute(action: InputAction): InputRoute {
  if (action.kind === "submit") return "work";
  if (action.command === "/btw") return "side";
  return CONTROL_COMMANDS.has(action.command) ? "control" : "work";
}

export class InputRouter<Attachment> {
  readonly work: InputQueue<SubmittedInput<Attachment>>;

  constructor(private readonly handlers: {
    blocked: () => boolean;
    run: (input: SubmittedInput<Attachment>, item: QueuedInput<SubmittedInput<Attachment>>, context: InputRunContext) => Promise<InputRunResult | void>;
    sessionId?: () => string;
    store?: InputQueueStore<SubmittedInput<Attachment>>;
    control: (input: SubmittedInput<Attachment>) => Promise<void>;
    side: (input: SubmittedInput<Attachment>) => boolean;
    onQueued: (position: number) => void;
    onError: (error: unknown) => void;
    onChange: () => void;
  }) {
    this.work = new InputQueue({
      blocked: handlers.blocked,
      run: handlers.run,
      onError: handlers.onError,
      onChange: handlers.onChange,
      store: handlers.store,
    });
  }

  submit(input: SubmittedInput<Attachment>): boolean {
    switch (inputRoute(input.action)) {
      case "side": return this.handlers.side(input);
      case "control":
        void this.handlers.control(input).catch((error) => {
          if (error instanceof InputRunCancelled) return;
          this.handlers.onError(error);
          this.handlers.onChange();
        });
        return true;
      case "work": {
        try {
          const position = this.work.enqueue(input, this.handlers.sessionId?.());
          if (position > 0) this.handlers.onQueued(position);
          this.handlers.onChange();
          return true;
        } catch (error) {
          this.handlers.onError(error);
          this.handlers.onChange();
          return false;
        }
      }
    }
  }
}

export function queuedInputText(input: SubmittedInput<unknown>): string {
  return input.action.kind === "submit" ? input.action.text : input.action.raw ?? input.text;
}
