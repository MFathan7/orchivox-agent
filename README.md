<p align="center">
  <img src="https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/assets/Orchivox%20Agent.jpeg" alt="Orchivox Agent logo" width="760" />
</p>

<h1 align="center">Orchivox Agent</h1>

A coding assistant for your terminal. Describe a task, and Orchivox reads your project, edits files, runs tests, and explains the result.

Works with hosted providers including OpenAI, Anthropic, OpenRouter, and OpenClaude, or local models through Ollama.

## Install

You need Node.js 20+ and a provider API key or a running Ollama server. Git enables snapshots, undo, and isolated worker checkouts.

```bash
npm install -g orchivox
```

Try without a global install: `npx orchivox@latest`. For a project-local install, use `npm install orchivox`, then `npx orchivox`.

<details>
<summary>Standalone installers</summary>

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/install.sh | bash
```

Windows (`cmd.exe` or PowerShell):

```bat
curl.exe -fsSL https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/install.cmd -o install.cmd
install.cmd
```

</details>

Supports Linux x64/arm64 (glibc), macOS Intel/Apple Silicon, and Windows x64. Published Linux binaries do not support Alpine/musl.

## Start

```bash
cd path/to/your/project
orchivox
```

On first launch, trust the folder, run `/connect` to add a provider, then `/models` to choose a model. Your choices are saved. For Ollama, start `ollama serve` first.

Type a request and press Enter:

```text
Explain the authentication flow.
Fix the failing tests in the payments module.
Plan a settings page before editing anything.
```

Press Tab to switch modes:

| Mode | Use it for |
| --- | --- |
| Plan | Read the project and discuss changes without editing project files. |
| Build | Edit files, run commands, and verify results. Default mode. |
| Ultrawork | Longer tasks with todos and delegation. |

## Commands and shortcuts

| Command | Action |
| --- | --- |
| `/connect`, `/models` | Set provider and model routes. |
| `/sessions` | Resume a saved conversation. |
| `/undo`, `/redo` | Undo or restore file changes. |
| `/settings` | Change approvals, limits, delegation, and animations. |
| `/hub` | Inspect workers, results, errors, and pending merges. |
| `/stats` | View context, token usage, and estimated cost; scroll with the wheel or arrow keys. |
| `/turn-report` | Inspect the last turn's tools, timing, and delegation. |
| `/compact` | Summarize older conversation context. |
| Ctrl+O | Expand or collapse thought, tool output, and diffs. |
| Page Up / Page Down | Scroll chat; use End with an empty input to return to the latest message. |
| Escape | Cancel the main turn and its child workers. |
| `/help` | Show all commands and shortcuts. |

## Subagents

The main agent can delegate focused tasks to workers with separate contexts. Write workers use isolated Git worktrees by default; their changes are reviewed before merging.

In `/settings`, choose a Delegation policy:

- `requested`: delegate only when explicitly requested.
- `balanced` (default): weigh independent work against setup cost.
- `eager`: prefer workers for substantial independent parts of a task.

Coordinator **On demand** makes the optional planning tool available. Neither setting guarantees a worker on every request. Small tasks can stay with the main agent.

Configure Fast and Advisor roles in `/models` with Ctrl+R for specialists that require them. They may use the same model as Main. Up to four workers run concurrently by default; excess workers queue.

Use `/hub` to inspect workers. If none appear, `/turn-report` distinguishes worker tools offered from workers actually called. Project settings can override global settings.

## Settings worth checking

- Build and Ultrawork default to **Safer Build** approvals for credentials, destructive actions, database commands, and code execution.
- New configurations allow 100 foreground tool calls and 20 minutes per turn. Change **Turn tool limit** and **Turn time limit** in Settings; `0` disables a limit. Existing explicit zeroes stay disabled.
- **Background titles** and **Idle recap** make extra model requests. Disable either in Settings to avoid those requests.
- **Animations** controls activity indicators. Thought stays collapsed by default; progress narration remains visible.

## Context and usage

Older context is summarized when needed. The completed **Compacted** divider shows the saved summary. Saved sessions, usage totals, and file changes survive compaction.

The context meter uses the latest provider input plus output measurement; `~` marks an estimate. The total below an answer sums all foreground model requests in that turn, including input history sent repeatedly. It can exceed the context window.

Session usage also includes workers, compaction, titles, and recaps. Cost labels mean:

| Label | Meaning |
| --- | --- |
| `~$…` | Estimated cost from reported usage and known rates. |
| `partial ~$…` | Some recorded usage cannot be priced. |
| `cost n/a` | No usable cost is known. |

These estimates depend on provider reports and pricing; they are not invoices.

`remember_insight` optionally saves decisions, conventions, and bug findings for later sessions in the same project. It is separate from chat history, compaction, and recap.

Overflowing chat shows a scrollbar on the right. Scroll with the wheel, click or drag the bar, or use the keyboard. New replies show their completion date (`dd/MM/yyyy HH:mm`) and elapsed time, including tool work and approval waits.

On Linux/macOS, drag chat text and release to copy it. Clipboard helpers are tried first, with a terminal clipboard request as fallback. On Windows, use native terminal selection; Windows Terminal requires Shift+drag while app mouse input is active, then its Copy shortcut or right-click action.

## Update

```bash
orchivox update --check
orchivox update
```

Use `orchivox update --rollback` if an update fails. Inside the app, `/update` checks for a release.

## Troubleshooting

- Command missing after a local npm install? Run `npx orchivox`. After the standalone installer, check that `~/.orchivox/bin` is on PATH.
- PowerShell blocks the launcher? Run `orchivox.cmd`.
- No model available? Run `/connect`, then `/models`.
- Wrong theme? Set `ORCHIVOX_APPEARANCE=light` or `dark` before starting.
- Windows commands require PowerShell 7 or Windows PowerShell 5.1. In WSL, run Orchivox inside the Linux filesystem.
- Report other problems in [GitHub Issues](https://github.com/MFathan7/orchivox-agent/issues).

## Uninstall

Run `npm uninstall -g orchivox` to remove the npm launcher. To also remove the standalone runtime and local data, delete `~/.orchivox`, `~/.local/share/orchivox`, and `~/.cache/orchivox`. This deletes settings, keys, sessions, and snapshots; back up what you need first.

If installed through the standalone installer, remove its Orchivox PATH entry from your shell config or Windows user PATH.
