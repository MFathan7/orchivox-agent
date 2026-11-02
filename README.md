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

Install the launcher:

```bash
npm install -g orchivox
```

Start Orchivox:

```bash
orchivox
```

The first run downloads the runtime for your platform and opens the terminal app. It also asks whether you trust the current folder.

Inside the app, run `/connect` to add a provider, then `/models` to choose a model. If you use Ollama, start it first:

```bash
ollama serve
```

The app saves your provider and model choices. You do not need to edit a config file.

To try it without a global install:

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
- `/help` shows all commands and shortcuts.

## Context and compaction

Orchivox budgets by tokens first. It keeps a buffer for the reply and summarizes older history near the model's input budget. `/stats` shows the context used, the request size, the input budget, and session spend.

Step, tool call, wall clock, repeated call, and web search caps are off by default. A turn continues until the model stops or you interrupt it. Set `modes.<mode>.steps` or the matching `limits.*` key to opt into a cap. When a step cap is reached, Orchivox keeps the tool definitions for the final request, disables tool choice, and asks for a summary instead of reporting an error.

Prune is off by default. When on, it removes old tool output without writing a summary, which can save context but can also increase how often the conversation needs a full summary. To opt in, set `compaction.prune: true` in `.agent/config.yaml`. The default budgets protect the most recent 40K tokens and only prune when the change frees at least 20K.

## Features

- Plan, build, and ultrawork modes.
- Reads, searches, and edits files across the project.
- Runs commands and tests.
- Undo and redo changes.
- Resumable sessions with search and branching.
- Parallel workers for large tasks.
- Hosted and local model support.
- Seven color themes, including a light preset, saved with your settings.
- Optional per-turn step, tool, and time caps, off by default, for when you want to bound a turn.
- Token-first compaction with a configurable context buffer; session spend and total tokens survive compaction.
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
- If no model is available, run `/connect` and then `/models`.
- If the light theme is not picked up or a theme looks unreadable, set `ORCHIVOX_APPEARANCE=light` or `ORCHIVOX_APPEARANCE=dark` before starting.
- If an update fails, run `orchivox update --rollback`.
- For other problems, open an issue at https://github.com/MFathan7/orchivox-agent/issues.

## Status

Orchivox is at version `0.5.0`. For long tasks, use a model with strong tool calling and a context window that matches the repository size.
