<p align="center">

  <img src="https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/assets/Orchivox%20Agent.jpeg" alt="Orchivox Agent logo" width="760" />

</p>

<h1 align="center">Orchivox Agent</h1>

<p align="center">

  A coding assistant for your terminal. Tell it what you need, and it works inside your project.

</p>

## What is Orchivox?

Orchivox is a coding assistant that runs in your terminal. You describe a task in plain language, and it reads your project, edits files, runs commands, and explains what it did. You can watch each step and undo changes if something goes wrong.

Use it to:

- understand an unfamiliar codebase
- add a feature or fix a bug
- run tests and work through failures
- review a file or ask a question about the code
- plan a larger change before editing anything

Orchivox works with hosted models such as OpenAI, Anthropic, OpenRouter, and OpenClaude, and with local models through Ollama.

## Install

You need Node.js 20 or newer. You also need a model provider: a local Ollama server or an API key for a hosted provider. Git is optional, but undo and snapshots need it.

### macOS and Linux

Install with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/install.sh | bash
```

### Windows

Run the batch installer from `cmd.exe` or PowerShell:

```bat
curl.exe -fsSL https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/install.cmd -o install.cmd
install.cmd
```

The Windows installer does not use PowerShell scripts. If PowerShell blocks `orchivox.ps1`, run `orchivox.cmd` instead.

### npm

For the global `orchivox` command:

```bash
npm install -g orchivox
orchivox
```

If you install it in a project instead, npm puts the launcher in
`node_modules/.bin`. Run it with `npx`:

```bash
npm install orchivox
npx orchivox
```

A local install does not add `orchivox` to your shell PATH. Use a global install if you want to run it from any folder.

The first run downloads the runtime for your platform and opens the terminal app. It also asks whether you trust the current folder.

Inside the app, run `/connect` to add a provider, then `/models` to choose a model. If you use Ollama, start it first:

```bash
ollama serve
```

The app saves your provider and model choices. You do not need to edit a config file.

To try the latest version without installing:

```bash
npx orchivox@latest
```

Supported platforms are Linux x64 and arm64 (glibc), macOS Intel and Apple Silicon, and Windows x64. Alpine and other musl systems are not supported by the published Linux binaries.

## Use it

Open a project folder and start Orchivox:

```bash
cd path/to/your/project
orchivox
```

Type a request and press Enter. For example:

- "Explain how the authentication flow works."
- "Fix the failing tests in the payments module."
- "Add a settings page and keep the existing style."
- "Review src/api/router.ts for error handling."

Orchivox has three modes. Press Tab to switch:

| Mode | What it does |
| --- | --- |
| Plan | Reads the project and discusses a plan without changing project files. |
| Build | Edits files and runs safe commands. This is the default. |
| Ultrawork | Runs longer tasks with a todo list and subagents. |

Useful commands:

- `/connect` adds or changes a model provider.
- `/models` chooses a model.
- `/sessions` opens past sessions.
- `/undo` and `/redo` move through file changes.
- `/commit` splits the current diff into commits.
- `/settings` changes approvals, safety presets, and step limits.
- **Animations** in `/settings` turns the activity-text sweep and tool spinners
  on or off. The preference is saved as `ui.animations` in your config. Static
  status is used for non-TTY output, `TERM=dumb`, and `NO_COLOR`.
- **Worker time limit** in `/settings` sets a total-time limit for new workers.
  It defaults to Off. Hub shows the effective model and latest progress; missing
  specialist model roles are reported before work begins.
- **Worker fallback** in `/settings` retries a retryable worker provider failure
  once on the session model. It defaults to Off. A write worker that already ran
  a tool is not restarted. A fallback result is marked in the worker result and
  Agent Hub.
- `/help` shows all commands and shortcuts.

## Sub-agents

Orchivox can hand focused work to a named sub-agent. The main agent keeps the
conversation, chooses the worker, and reviews the result. Each worker gets its
own context and tool policy. Workers cannot spawn other workers.

### The team

| Agent | Role | Access | Model role | Use it for |
| --- | --- | --- | --- | --- |
| `polaris` | Read-only planning coordinator. Returns a structured WorkPlan. | Read-only | main | Multi-step plans, task decomposition, acceptance criteria |
| `sisyphus` | Primary orchestrator. Drives work to completion and verifies it. | Read and write | main | End-to-end execution, todos, verification, delegation |
| `oracle` | Principal architect and deep debugger. | Read-only | advisor | Architecture, trade-offs, invariants, root-cause analysis |
| `explore` | Fast codebase scout. | Read-only | fast | Repository maps, symbol search, entry points |
| `librarian` | Documentation and research specialist. | Read-only | fast | External docs, libraries, papers, citations |
| `frontend-ui` | UI, styling, and accessibility specialist. | Read and write | main | Terminal and web interfaces, layout, keyboard access |
| `programmer` | Implementation worker. | Read and write | main | Focused code changes, tests, verification |

Read-only is enforced by the tool policy, not just by the prompt. A read-only
agent does not receive write, mutating shell, task board, or subagent tools.

`main`, `fast`, and `advisor` are model roles. Configure
`roles.fast_model` and `roles.advisor_model` in `/models` before using agents
that request those roles. If a role is not configured, invoking that agent
returns an error instead of silently using another model.

In `/models`, press `Ctrl+R` to open the target list. Choose **Fast** or
**Advisor**, press Enter, then choose a model and press Enter to save it.
You can assign the same model as the session model. Role assignments leave
the Plan, Build, and Ultrawork mode models unchanged.

### Invoke a specialist

Prefix a message with `@name`:

```text
@oracle review the retry path in src/agent/coordinator.ts
@explore map the TUI entry points and the files that own them
@programmer fix the failing test in tests/task-board-limit.test.ts
```

`@sisyphus` is the primary orchestrator profile. Use it when you want a lead
that tracks todos, verifies the result, and delegates independent work.
`@polaris` is the planning coordinator; you can use it directly to produce a
WorkPlan, or let the coordinator run it automatically.

### Spawn workers

Use the `spawn_subagents` tool for explicit workers. A batch can run in
parallel, as a chain, or in the background:

- `background` is the default. It returns worker ids immediately so the main
  agent can keep working. Results are delivered during the next model step or
  saved for the next turn. The limit is 8 workers per batch.
- `parallel` explicitly waits for the whole batch.
- `chain` runs them in order and passes the previous result through
  `{previous}`.
- `writeIsolation: true` gives a write worker its own Git worktree. This is
  the default for write workers, including background workers. Review its diff,
  then call `task_merge` with the worker id. Background workers never auto-merge.
- `writeIsolation: false` runs in the current workspace. Use it for read-only
  work or a pipeline that must share files.
- `skills` per task narrows the specialist's skill allowlist. It cannot widen
  it.
- `mode: "plan"` per task enforces read-only tools, including for an unnamed
  worker. Read-only specialists enforce it automatically.
- `continue_from` continues from a completed worker. Merge isolated work first
  if its files matter.

Every task should include the paths, constraints, acceptance criteria, and
decisions the worker needs. Workers do not see the parent conversation.

`task_list` includes direct workers and task-board work. `task_wait` accepts
`ids`, `wait_for: "any" | "all"`, and `timeout_seconds`. By default it waits
up to 30 seconds for the first active worker result, leaving other workers
running. Use `all` only when the next step needs every result. `task_cancel`
accepts worker ids too. Plan mode can list and wait for its read-only workers.

All worker batches share `orchestration.max_concurrent_workers` (default 4,
range 1–8). Excess workers queue. Read-only specialists use the shared checkout
without creating worktrees. A project study can use several focused read-only
workers while the main agent inspects another area; it does not authorize edits.

Settings **Delegation** controls when the main agent should use workers:
`requested` waits for an explicit user or project instruction, `balanced`
(default) delegates substantial independent work after brief scoping, and
`eager` prefers parallel slices when setup and shared edits permit it. Each
policy keeps integration with the main agent and respects mode permissions.
Set this with `orchestration.delegation`; **Coordinator** remains a separate
choice about the availability of the optional planning tool.

### Coordinator

Configure Polaris in `/settings` under **Coordinator**, or in
`.agent/config.yaml`:

```yaml
orchestration:
  # off | ultrawork | always
  auto_delegate: always
  coordinator_agent: polaris
  max_concurrent_workers: 4
```

- `off` hides Polaris. Direct subagents and task board tools stay available.
- `ultrawork` makes Polaris optional in Ultrawork only.
- `always` makes Polaris optional in Build and Ultrawork. This is the default
  and appears as **On demand** in settings. The value is retained for config
  compatibility; it no longer forces a planning pass before each turn.

The main agent starts directly under every policy. It decomposes independent
work itself and calls `coordinate` only when a separate dependency plan helps.
That explicit call waits for Polaris to plan; ordinary turns pay no planning
request. Existing explicit config values are preserved.

Polaris reads the project and returns a WorkPlan JSON object. The orchestrator
validates task ids, dependencies, cycles, task count, agent names, installed
skills, and skill allowlists. The task board starts the workers, including
dependency chains. The main agent waits for tasks, reviews results, and merges
only what passes. A task can be cancelled with `x` on the task board.

When a dependency has an isolated worktree, its dependents wait until the main
agent reviews and merges it with `task_merge`. `task_wait` returns the pending
merge ids rather than waiting indefinitely. Successful merges start ready
dependents with the updated code.

### Visibility and control

- The header shows `agents N` while workers are active.
- A one-line status above the composer shows running, queued, and failed counts.
- `/hub` opens Agent Hub for transcripts, task detail, skills, usage, and
  stop/steer actions.
- `k` stops the selected worker. `K` stops all workers.
- Escape cancels the current main turn and its child workers.
- Approval requests that belong to a stopped worker are denied automatically.
- Worker usage is added to the session cost and appears in `/stats` and Agent
  Hub.

### Skills per agent

Specialist files in `.agent/agents/*.md` accept:

```yaml
skills: [planning, architecture]
skillPolicy: listed
preloadSkills: [planning]
```

- `skillPolicy: all` shows every installed skill. This is the default.
- `skillPolicy: listed` shows only `skills`.
- `skillPolicy: none` hides the skill tools for that agent.
- `preloadSkills` loads a small number of skill bodies before the first model
  call. Keep the list short because it costs tokens.

A task can narrow the allowlist with `skills` in `task_create` or
`spawn_subagents`. A task cannot widen it. Skills are loaded on demand; they are
not always-on role rules.

### Custom agents

Project agents live in `.agent/agents/<name>.md` with YAML frontmatter and a
Markdown system prompt. A custom agent can override a built-in agent with the
same name. Supported fields include `description`, `roleModel`, `readOnly`,
`thinkingBudget`, `allowedTools`, `skills`, `skillPolicy`, `preloadSkills`, and
`permissions`.

Orchestration is configured through `.agent/config.yaml` and driven from the
task board. Workers keep separate context and return results for review before
anything is merged.

## Context and compaction

Orchivox budgets by tokens first. It keeps a buffer for the reply and summarizes older history near the model's input budget. `/stats` shows the context used, the request size, the input budget, and session spend.

Step, tool call, wall clock, repeated call, and web search caps are off by default. A turn continues until the model stops or you interrupt it. Set `modes.<mode>.steps` or the matching `limits.*` key to opt into a cap. `limits.worker_tokens` caps one worker at that many tokens, with a warning at 80% and a hard stop. It defaults to 0; the 40-turn worker cap still applies. When a step cap is reached, Orchivox keeps the tool definitions for the final request, disables tool choice, and asks for a summary instead of reporting an error.

Prune is off by default. When on, it removes old tool output without writing a summary, which can save context but can also increase how often the conversation needs a full summary. To opt in, set `compaction.prune: true` in `.agent/config.yaml`. The default budgets protect the most recent 40K tokens and only prune when the change frees at least 20K.

## Background titles and idle recap

In the TUI, a session title starts generating after the first text, reasoning,
or tool progress while the main answer continues. After a completed answer and
240 idle seconds, a recap describes the goal, current result, and next action.
The recap waits for background workers and stays separate from the model's
conversation history. Resuming a session shows its saved recap.

Settings includes **Background titles**, **Idle recap**, and **Recap delay**.
These features make extra model requests; reported usage is added to the session
cost. They use the active request's model and preserve its system parts and tool
catalog for provider caching, while disabling tool execution. Cache hits depend
on the provider. One side request runs at a time, with a default 30-second total
timeout including queue time. A failure keeps the provisional title and does not
interrupt the main answer. Typing, opening a menu, changing session, or starting
work cancels an idle recap. Escape and shutdown also cancel background requests.

```yaml
background:
  titles: true
  recap: true
  recap_idle_seconds: 240
  timeout_seconds: 30
```

## Latency reports and benchmarks

`/turn-report` separates first provider progress from first answer text, lists
provider durations, retries and reported cache tokens, and shows summed tool
time, worker queue time, and explicit worker waits. Summed tool durations can
overlap. It also shows whether worker tools were offered and how many workers
were actually called; zero workers alone does not explain the model's decision.

Run a read-only benchmark from source:

```bash
bun run benchmark:agents --prompt "Read README.md and explain the entry point" --runs 3 --output /tmp/orchivox-benchmark.json
```

Use `--config` and `--secrets` for a specific configured route, `--repo` for the
fixture directory, `--reasoning` to record a fixed effort, and `--expect-text`
for a literal answer check. `--agent both --omp-model provider/model` also runs
an installed, configured OMP CLI with read-only tools. Each run uses a fresh
conversation. Reports contain timing and token metadata, not prompts or raw
transcripts. Compare equivalent provider routes and reviewed answers; different
system prompts and tool catalogs prevent this from being a pure model speed test.

For a repeatable study and implementation comparison, run the workflow suite:

```bash
bun run benchmark:agents --suite benchmarks/workflow.json --agent both --omp-model provider/model --reasoning low --runs 3 --output /tmp/workflow-benchmark.json
```

Each sample starts from a separate copy of the same fixture and a fresh
conversation. Agent order alternates across runs. The implementation case
has two independent defects and an external behavior verifier; changing the
verifier or files outside the requested scope fails acceptance. A study must
leave the files unchanged and satisfy the stated answer criteria. Temporary
workspaces and copied configuration are removed after the run. Provider
credentials stay out of reports.

The suite selects the same main model for worker role defaults. Check the
provider endpoints as well as the model ids before comparing speed. Reports
record effective Orchivox reasoning and the requested OMP reasoning, show
model/effort/fixture mismatches, and keep timings separate by case and route.
Only samples that satisfy acceptance contribute to timing summaries. The
included fixture checks two small helper contracts; it does not establish
performance on a large project or prove subjective answer quality.

## Completion and turn limits

The main agent uses the requested outcomes as its completion criteria, reuses
collected evidence, and finishes once the requested behavior and required
checks are verified. Additional verification needs a relevant change, failure,
or specific unresolved uncertainty. This policy also applies to visual checks.

Every 25 tool calls, a visible progress checkpoint asks the model to review
remaining work and missing evidence in its next normal request. Checkpoints
make no additional model calls, do not infer completion from unchanged files,
and never reject a final answer. `/turn-report` includes the checkpoint count.

New configurations default to 100 foreground tool calls and 1200 seconds per
turn. A tool cap allows one final response without tool execution. A time cap
cancels foreground provider requests and signals running tools; tools that
ignore cancellation must finish their in-flight operation. Completed edits
remain available. A limit stop is reported as `turn_limit`, with remaining
work distinguished from verified results. It never starts another turn.
Background workers keep their separate concurrency and worker limits.

Use Settings **Progress check**, **Turn tool limit**, and **Turn time limit**
to change these values for the next message:

```yaml
limits:
  checkpoint_interval: 25
  max_tool_calls: 100
  max_wall_seconds: 1200
orchestration:
  delegation: balanced
```

`0` disables the corresponding checkpoint or limit. Existing explicit zeroes
are preserved, including configurations written by older releases. Check
Settings if an existing installation still shows its turn limits as **Off**.

## Shells and platforms

Windows uses basic keyboard input by default. Private kitty/xterm keyboard
sequences are not sent to CMD, and redraws reset text attributes before erasing
to prevent a cursor or selection color from filling the background. A terminal
known to support enhanced input can opt in with
`ORCHIVOX_KEYBOARD_PROTOCOL=extended`; `off` disables it on any platform.

The `shell` tool uses the platform shell:

- Linux and macOS: bash when available, then the login shell, then zsh or sh.
- Windows: PowerShell 7 (`pwsh`) when available, otherwise Windows PowerShell 5.1. Bash is not required.

Background processes, hooks, and custom-command inline shell use the same shell. Set `ORCHIVOX_SHELL` to `bash`, `zsh`, `sh`, `pwsh`, or `powershell` when you need an explicit override. The `shell` tool accepts `workdir`, and `bg_start` accepts `cwd`.

Plan mode only allows read-only inspection commands. On Windows this uses a PowerShell allowlist; commands that change state or evaluate code are rejected.

If Windows cannot find PowerShell, install PowerShell 7 or enable Windows PowerShell. On macOS, Orchivox does not depend on an `env -0` extension that older releases lack. For WSL, run Orchivox inside the Linux filesystem instead of mixing `C:\` paths with a WSL shell.

## Approvals and plan files

Build and Ultrawork use the **Safer Build** approval preset by default. Credential reads, destructive file and database actions, database CLI commands, and `execute` ask first. Approval offers once, allow for session, deny, and deny with feedback. `/settings` switches between Safer Build, Env-only, Permissive, and Custom, and sets per-mode step limits.

The automatic fatal guard always rejects `rm -rf` against root, home, wildcard
paths, parent traversal, and system roots. Other destructive paths follow the
active approval preset. For example, `rm -rf /tmp/pw` is not treated as fatal.

Plan mode writes plans to `~/.orchivox/plan` (`ORCHIVOX_PLAN_HOME` overrides it). Build and Ultrawork write plan files to the active project root. `.agent` is reserved for configuration and is never a plan directory.

## Features

- Plan, build, and ultrawork modes.
- Named sub-agents: Polaris, Sisyphus, Oracle, Explore, Librarian, Frontend-UI, Programmer.
- Optional Polaris coordinator with off, Ultrawork-only, and on-demand availability.
- Per-agent skill allowlists and per-task skill assignment.
- Custom sub-agents in `.agent/agents/*.md`.
- Reads, searches, and edits files across the project.
- Runs commands and tests.
- Undo and redo changes.
- Resumable sessions with search and branching.
- Parallel, chain, and background workers with worktree isolation, result delivery, review, and stop/steer.
- Hosted and local model support.
- Seven color themes, including a light preset, saved with your settings.
- Optional per-turn step, tool, and time caps, off by default, for when you want to bound a turn.
- Token-first compaction with a configurable context buffer; session spend and total tokens survive compaction.
- Platform-aware shell execution on Linux, macOS, and Windows, including background processes, hooks, and custom commands.
- Safer Build and Ultrawork approvals for credentials, destructive actions, database tools, and code execution.
- Optional repeated-call detection and a per-turn read cache.
- Model-aware edit tools and bounded code search.
- Optional code mode for batching tool calls in one sandboxed script.
- Web search through Tavily, Brave, Exa, Firecrawl, or DuckDuckGo, with provider fallback and per-session memory.
- Per-agent permissions, a conservative plan-mode shell scanner, and task board caps.
- Live turn budget status and a `/turn-report` breakdown.
- A turn observation script to compare models and reasoning levels before adding a profile.
- Automation options for scripts and other tools.

## Update

Check for a new version:

```bash
orchivox update --check
```

Install the update:

```bash
orchivox update
```

Return to the previous version if needed:

```bash
orchivox update --rollback
```

Inside the app, `/update` checks for a new release.

## Uninstall

Remove the npm launcher:

```bash
npm uninstall -g orchivox
```

Remove the runtime and your local data:

```bash
rm -rf ~/.orchivox
rm -rf ~/.local/share/orchivox
rm -rf ~/.cache/orchivox
```

This deletes your settings, API keys, sessions, and snapshots. Back up anything you want to keep first.

If the installer added Orchivox to your PATH, remove the block between `# >>> orchivox installer >>>` and `# <<< orchivox installer <<<` from your shell config. On Windows, remove `%USERPROFILE%\.orchivox\bin` from your user PATH.

## If something goes wrong

- If `orchivox` is not found, add `~/.orchivox/bin` to your PATH and restart your terminal.
- If `orchivox` is not found after `npm install orchivox`, that install was local. Run `npx orchivox` or install globally with `npm install -g orchivox`.
- If PowerShell says running scripts is disabled, run `orchivox.cmd` instead of `orchivox`.
- If the installer shows plain output, it is non-interactive. Run it in a terminal, unset `CI` or `TERM=dumb`, or pass `--verbose` to see the detection result.
- If no model is available, run `/connect` and then `/models`.
- If the light theme is not picked up or a theme looks unreadable, set `ORCHIVOX_APPEARANCE=light` or `ORCHIVOX_APPEARANCE=dark` before starting.
- If an update fails, run `orchivox update --rollback`.
- For other problems, open an issue at https://github.com/MFathan7/orchivox-agent/issues.

## Status

Orchivox is at version `0.6.1`. For long tasks, use a model with strong tool calling and a context window that matches the repository size.
