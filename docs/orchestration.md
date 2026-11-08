# Orchestration

Orchivox can plan multi-step work with Polaris, a read-only coordinator, before
workers run. The coordinator produces a structured WorkPlan. The main agent
turns that plan into task board work and reviews the results.

## Modes

Set `orchestration.auto_delegate` in `.agent/config.yaml`, or use the
**Auto coordinator** row in `/settings`.

| Value | Behavior |
| --- | --- |
| `off` | No automatic coordinator. Manual subagents and task board tools stay available. |
| `ultrawork` | Polaris is available in Ultrawork only. Build stays direct. |
| `always` | Polaris runs before every Build and Ultrawork turn with a user message. |

The default is `off`. `always` adds a planning request before the main turn and
can increase token cost.

```yaml
orchestration:
  auto_delegate: off
  coordinator_agent: polaris
```

`coordinator_agent` must name a registered specialist. The built-in coordinator
is `polaris`.

## Flow

1. The main agent calls `coordinate`, or the orchestrator runs Polaris for an
   `always` turn.
2. Polaris reads the project when needed. It cannot edit files.
3. Polaris returns a WorkPlan JSON object.
4. The orchestrator validates task ids, dependencies, cycles, task count, agent
   names, installed skills, and skill allowlists.
5. The task board starts the workers. Dependencies can run as a pipeline.
6. The main agent calls `task_wait`, reviews the results, and merges only the
   work that passes.
7. Workers keep separate context. The task text carries the objective,
   constraints, relevant files, and acceptance criteria they need.

A WorkPlan looks like this:

```json
{
  "objective": "Add a settings page",
  "constraints": ["Keep the existing theme system"],
  "relevant_files": ["src/tui/settings-modal.tsx"],
  "tasks": [
    {
      "id": "implement",
      "title": "Implement the page",
      "task": "Add the page and wire it to the modal.",
      "agent": "programmer",
      "skills": ["implementation"],
      "depends_on": [],
      "write_isolation": true,
      "mode": "build",
      "acceptance": ["Typecheck passes", "Existing settings tests pass"]
    }
  ],
  "merge": false
}
```

## Agents

- `polaris` is the read-only planning coordinator. It has read, search, LSP,
  and skill tools. It never edits files.
- `programmer` is the implementation worker. It reads before editing, keeps the
  diff focused, and runs the relevant checks.
- Existing specialists such as `oracle`, `explore`, and `frontend-ui` can also
  receive tasks.

Workers cannot spawn other workers. `coordinate`, `spawn_subagents`, and task
board tools are blocked inside a worker, so delegation stays one level deep.

## Skills per agent

Specialist files in `.agent/agents/*.md` accept:

```yaml
skills: [planning, architecture]
skillPolicy: listed
preloadSkills: [planning]
```

- `skillPolicy: all` shows every installed skill. This is the default.
- `skillPolicy: listed` shows only `skills`.
- `skillPolicy: none` hides the skill tools for this agent.
- `preloadSkills` loads a small number of skill bodies before the first model
  call. Keep this list short because it costs tokens.

A task can narrow the allowlist further. `task_create` and `spawn_subagents`
accept `skills` per task. A task cannot widen a specialist's allowlist.

Skills can contain instructions, scripts, templates, and reference files. Those
resources run through the existing tools, usually `shell` or `read_file`. A
skill does not register a new tool in the Orchivox registry.

## Safety and cancellation

- Workers use the same permission engine as the main agent. They still ask for
  approval when a rule requires it.
- Agent Hub: `k` stops the selected worker, `K` stops all workers.
- The header shows `agents N` while workers are active. A one-line status above
  the composer shows running, queued, and failed counts, and points to `/hub`
  for transcripts and task detail.
- Task board: `x` cancels the selected task.
- Escape on the main turn cancels the turn and its child workers.
- An approval that belongs to a stopped worker is denied automatically.
- Stopped workers clean up their worktree. If cleanup fails, the path is shown
  for manual inspection.
- Worker usage is added to the session cost and appears in `/stats` and Agent
  Hub.

## Cost

There is no user-facing token budget for orchestration. `always` is the most
expensive mode because it adds a coordinator request to every Build and
Ultrawork turn. Use `off` or `ultrawork` when you want to keep normal turns
cheap. The header cost and `/stats` include worker usage.

## Verification

```bash
bun run typecheck
bun test
bun run check:secrets
git diff --check
```

For a manual check, enable `always`, send a multi-step task in Build, and watch
the task board. Then stop one worker with `k`, stop all with `K`, and cancel a
task with `x`. Make sure no worker or task is left running.
