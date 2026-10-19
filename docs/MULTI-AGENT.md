# Multi-agent tasks

Orchivox has two layers for parallel work:

- `spawn_subagents` runs a list of tasks and waits for every worker.
- The task board (`task_create`, `task_list`, `task_dispatch`,
  `task_cancel`) tracks a DAG and can start new work as dependencies finish.

## Task board tools

| Tool | What it does |
| --- | --- |
| `task_create` | Creates one or more tasks and, by default, starts every task whose dependencies are complete. |
| `task_list` | Lists state, dependencies, worker ids, changed files, and short results. |
| `task_dispatch` | Starts pending tasks whose dependencies are complete, up to the concurrency limit. |
| `task_cancel` | Cancels a pending or running task. Dependents become blocked. |
| `task_merge` | Merges a completed task's worker branch into the current branch and removes its worktree. |
| `task_wait` | Waits until no task is running, then returns the final board. |

Task fields:

```json
{
  "id": "parser",
  "title": "Build the parser",
  "task": "Implement the parser and its tests.",
  "agent": "sisyphus",
  "depends_on": [],
  "role_model": "main",
  "provider": "openai_primary",
  "model": "gpt-4.1",
  "write_isolation": true
}
```

- `depends_on` builds the DAG. A task starts only after every dependency is
  `completed`. If a dependency fails, is blocked, or is cancelled, dependents
  become `blocked`.
- `role_model` routes the worker to the `main`, `fast`, or `advisor` role.
- `provider` plus `model` overrides the role and uses an exact provider and
  model from `.agent/config.yaml`.
- `write_isolation` defaults to `true` and gives each worker its own git
  worktree under `.agent/worktrees/`.

The board runs at most three tasks at once. When a worker finishes, the board
records its output, changed files, and a diff excerpt, then starts newly ready
tasks.

The board is stored in the SQLite database. Tasks and their results survive a
restart. A task that was `running` when the process stopped is restored as
`pending` with its worker id cleared, so it can be dispatched again from the
hub. Tasks whose dependency is missing, failed, blocked, or cancelled are
restored as `blocked`.

Each task records the session mode (`plan`, `build`, `ultrawork`) that created
it, and its workers run with that mode. Concurrent turns and API requests keep
their own mode through async context, so one run cannot change another run's
permissions. An explicit mode on a worker overrides the ambient turn mode.

Subagent workers cannot call `spawn_subagents` or the task board tools, so a
worker cannot recursively create more workers.

## States

`pending`, `running`, `completed`, `failed`, `blocked`, `cancelled`.

## In the TUI

- `/tasks` opens the hub on the Tasks tab.
- `/hub` or `Alt+A` opens the Workers tab.
- In the hub, `Tab` switches tabs, `d` dispatches ready tasks, `x` cancels a
  task, `m` merges a completed task, `s` steers a worker, and `k` kills a
  worker.
- The selected task shows its route, worker id, result excerpt, changed files,
  and diff excerpt.
