<p align="center">
  <img src="assets/Orchivox%20Agent.jpeg" alt="Orchivox Agent logo" width="760" />
</p>

<h1 align="center">Orchivox Agent</h1>

<p align="center">
  A terminal coding agent that reads your repository, edits files, runs commands, and keeps a session history you can resume.
</p>

Orchivox runs as a full-screen terminal UI, a headless command, an HTTP gateway, or a Model Context Protocol (MCP) server. It works with hosted models and local Ollama models. The same runtime handles planning, file edits, shell commands, web access, Git snapshots, and isolated subagents.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Running Orchivox](#running-orchivox)
- [TUI basics](#tui-basics)
- [Building a binary](#building-a-binary)
- [Development](#development)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Status](#status)

## Overview

Orchivox is built for repository work that takes more than one turn. It can inspect a codebase, propose a plan, edit files, run tests, and keep the result in a session you can reopen later.

The terminal interface is the main entry point. It shows the mode, active model, context usage, session cost, tool activity, and the final answer in one place. Reads, searches, and commands are grouped into a single `Activity` row. Click the row or press `Ctrl+O` to open it.

The same agent can run without the TUI:

- A headless prompt for scripts and CI.
- An HTTP gateway with OpenAI-compatible and Anthropic-compatible endpoints.
- An MCP server that exposes the agent tools over stdio.

Orchivox uses Bun for execution, TypeScript for the runtime, React and Ink for the terminal UI, and SQLite for session storage. Git is used for worktrees, snapshots, and commit splitting.

## Features

### Three working modes

| Mode | What it is for |
| --- | --- |
| Plan | Read-only inspection, architecture questions, and implementation plans. File changes are blocked. |
| Build | Normal repository work. File edits ask for approval before they run. |
| Ultrawork | Longer autonomous work with a todo list, task board, and subagents. |

Switch modes with `Tab`, `/plan`, `/build`, `/ultrawork`, or `/mode`.

### Editing with repository context

Orchivox is not limited to whole-file rewrites. The tool set includes:

- Hash-anchored edits through `hash_edit`.
- File creation, deletion, and moves.
- Unified patches through `apply_unified_patch`.
- File reads, globbing, regex search, and diff views.
- Abstract syntax tree (AST) skeletons and repository maps.
- Language Server Protocol (LSP) diagnostics, workspace symbols, hover types, and symbol impact analysis.
- Image inspection for screenshots and diagrams.

Before a file change, Orchivox captures a Git snapshot. That snapshot powers `/undo`, `/redo`, and `/timeline`.

### Parallel work with isolated subagents

Large tasks can be split across subagents. Each worker can run in its own Git worktree, so parallel edits do not collide. The task board can dispatch, cancel, and merge work.

Use `/hub` to inspect workers and `/tasks` to open the task board. The agent can also create tasks directly when running in Ultrawork mode.

### Sessions you can resume

Sessions and messages are stored in `.agent/memory.db`, which is ignored by Git. Orchivox keeps the mode, model, token usage, and session cost. Tool activity is shown while a turn runs.

- `/sessions` opens the session manager and search.
- `/fork` branches a conversation from a selected turn.
- `/compact` compresses old context, and automatic compaction runs when the context window is nearly full.
- The answer footer shows the mode, model, and generation speed.

### Provider flexibility

Orchivox supports these provider kinds:

- `openai`
- `anthropic`
- `openclaude`
- `ollama`
- `openrouter`

Use `/connect` to add, edit, enable, or delete providers. Choose **Custom provider** to connect any OpenAI-compatible or Anthropic-compatible endpoint with your own provider name and API URL. After a successful test, every model returned by the provider is saved. The provider manager shows installed local models and checks remote providers against their live model list when an API key is available.

Use `/models` to browse models grouped by provider and assign a model to a role or mode. Type directly to search, without pressing `/`. `Ctrl+Backspace` or `Ctrl+Delete` deletes a word, `Ctrl+R` cycles the target role, `Ctrl+A` toggles non-chat models, and `Tab` opens Providers.

Models are assigned by role:

- `main_model` handles normal turns.
- `fast_model` handles lightweight work.
- `advisor_model` can review or advise on larger changes.

You can also set a model per mode and a reasoning effort per mode. Model capabilities such as context window, vision, tool calling, and structured output can be overridden in the provider profile.

### Context, rules, skills, and plugins

- Project instructions can come from `AGENTS.md`, `CLAUDE.md`, and the file named by the project directive, such as `.agent/agents/AGENTS.md`.
- Markdown rule files under `.agent/rules/` can be loaded by file pattern.
- Skills can add focused instructions and tool policies.
- Plugins can add runtime tools from `.agent/plugins/`.
- Custom slash commands live in `.agent/commands/`.
- Stream rules can abort and retry a generation when the output matches a pattern.

### Automation interfaces

- `--prompt` runs one task and prints text or JSON.
- `serve` starts the HTTP gateway.
- `mcp` exposes the agent tools as an MCP server.
- Web search and web fetch are available as tools.
- Background processes can start, stream logs, list, and stop.

### Guardrails

- The first TUI launch asks whether to trust the workspace. Use `--trust` only when you already trust the directory.
- Build mode asks for approval before writes.
- Sandbox permissions control filesystem, network, and command access.
- The gateway binds to `127.0.0.1` by default. Put it behind a trusted proxy if you need remote access.
- `.agent/secrets.yaml` is ignored by Git.

## Requirements

- Bun 1.1 or newer.
- A Git repository for worktrees, snapshots, and `/commit`. Other features can run outside Git, but those features need it.
- A model provider:
  - Ollama running locally, or
  - an API key for OpenAI, Anthropic, OpenClaude, or OpenRouter.
- Optional: language servers such as `typescript-language-server`, `pylsp`, `rust-analyzer`, or `gopls`.

## Quick start

Install dependencies from the repository root:

```bash
bun install
```

If you want to use a local model, start Ollama and pull a tool-calling model:

```bash
ollama serve
ollama pull qwen2.5-coder:7b
```

Edit `.agent/config.yaml` so it points to a provider and models you can reach. The repository includes an example configuration. Replace the provider block and the roles, or use the minimal configuration below.

Start the terminal UI:

```bash
bun run start
```

The first launch asks whether to trust the workspace. After that, type a prompt and press `Enter`.

You can also run the source directly:

```bash
bun run src/index.ts
```

### Minimal local configuration

```yaml
version: 1

providers:
  ollama:
    kind: ollama
    base_url: http://127.0.0.1:11434/v1
    timeout_ms: 120000
    models:
      - qwen2.5-coder:7b

roles:
  main_model:
    provider: ollama
    model: qwen2.5-coder:7b
  fast_model:
    provider: ollama
    model: qwen2.5-coder:7b
  advisor_model:
    provider: ollama
    model: qwen2.5-coder:7b
```

You can point `fast_model` and `advisor_model` at smaller or cheaper models when you have them.

### Hosted provider configuration

```yaml
version: 1

providers:
  openai:
    kind: openai
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}
    models:
      - gpt-4.1

roles:
  main_model:
    provider: openai
    model: gpt-4.1
  fast_model:
    provider: openai
    model: gpt-4.1-mini
  advisor_model:
    provider: openai
    model: gpt-4.1
```

You can put provider keys in `.agent/secrets.yaml` instead of the main config:

```yaml
providers:
  openai:
    api_key: sk-your-key
```

Or export the key before starting:

```bash
export OPENAI_API_KEY="sk-your-key"
```

The loader replaces `${NAME}` placeholders from the environment. A placeholder that resolves to an empty value removes the field, so optional settings stay absent.

## Configuration

Orchivox resolves config in this order:

1. `--config <path>` and `--secrets <path>`
2. `ORCHIVOX_CONFIG` and `ORCHIVOX_SECRETS`
3. Project config: `.agent/config.yaml`
4. Global config: `~/.orchivox/config.yaml`
5. Empty defaults

Project config wins over global config. Secrets resolve separately, and a missing project secrets file can fall back to `~/.orchivox/secrets.yaml`.

```bash
orchivox --config ~/.orchivox/config.yaml
ORCHIVOX_CONFIG=~/.orchivox/config.yaml orchivox
```

The main configuration file is `.agent/config.yaml` or the active global config. The secrets file is `.agent/secrets.yaml` or `~/.orchivox/secrets.yaml`.

Provider API keys belong in the secrets file, not in tracked config. The config writer strips `api_key` from provider profiles before saving config. Run `bun run check:secrets` before pushing to verify tracked files do not contain key-like values and that `.agent/secrets.yaml` is ignored.

To share one config across projects:

```bash
mkdir -p ~/.orchivox
chmod 700 ~/.orchivox
cp .agent/config.yaml ~/.orchivox/config.yaml
cp .agent/secrets.yaml ~/.orchivox/secrets.yaml
chmod 600 ~/.orchivox/secrets.yaml
```

After that, projects without `.agent/config.yaml` use the global config automatically.

| Key | What it controls |
| --- | --- |
| `providers` | Provider profiles, base URLs, model lists, capabilities, pricing, and timeouts. |
| `roles` | The main, fast, and advisor models. |
| `modes` | Per-mode model and reasoning overrides. |
| `inbound_server` | Gateway port and API key. |
| `lsp` | Language server commands and root markers. |
| `mcp.servers` | MCP servers to connect to. |
| `hooks` | Commands to run before or after tools, and when a turn stops. |
| `sandbox` | Filesystem, network, and command permissions. |
| `compaction` | Automatic context compaction thresholds. |
| `websearch` | Web search provider and enablement. |
| `webfetch` | Web fetch enablement. |
| `prompt` | System prompt style: `auto`, `full`, or `compact`. |

### Model capabilities

Capabilities can be inferred, read from the model catalog, read from Ollama, or overridden per model:

```yaml
providers:
  openai:
    kind: openai
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}
    models:
      - gpt-4.1
    model_capabilities:
      gpt-4.1:
        context_window: 1047576
        vision: true
        tool_calling: true
```

Use overrides when the provider does not expose the model metadata you need.

## Running Orchivox

The CLI examples below use `bun run src/index.ts` so they work from a checkout. The TUI also has the shorter `bun run start`. If you linked the package, use `orchivox` instead.

### Terminal UI

```bash
bun run start
```

Or, after linking the package:

```bash
bun link
orchivox
```

The linked command uses the source entry point in `bin/orchivox.js`. If `orchivox` is not on your `PATH`, run `bun run bin/orchivox.js`. If you do not want to link it, use `bun run src/index.ts` from the repository.

### Headless prompt

```bash
bun run src/index.ts -p "summarize this repository" --mode plan
bun run src/index.ts -p "fix the failing tests" --mode build
bun run src/index.ts -p "inspect the API routes" --mode plan -f json
```

The result is printed to stdout. `-f json` returns the full result object, including the final message and usage.

### HTTP gateway

```bash
bun run src/index.ts serve --port 8787
```

The gateway binds to `127.0.0.1` and exposes:

- `POST /v1/chat/completions` for OpenAI-compatible clients.
- `POST /v1/messages` for Anthropic-compatible clients, including OpenClaude clients.
- `GET /v1/models` for the available agent profiles.
- `POST /v1/agent/tasks` and `GET /v1/agent/tasks/{id}` for background tasks.
- `GET /openapi.json` for the OpenAPI document.
- `GET /docs` for the Scalar API reference.

If `inbound_server.api_key` is set, `/v1/*` requires either:

```text
Authorization: Bearer <key>
```

or:

```text
x-api-key: <key>
```

The API key protects `/v1/*`. `/openapi.json` and `/docs` are served without it, so protect them at the proxy if the gateway is exposed.

The gateway does not provide TLS or a public reverse proxy. Add those yourself if you expose it.

### MCP server

```bash
bun run src/index.ts mcp
```

This exposes the agent tools as an MCP server over stdio. Orchivox also acts as an MCP client for servers listed under `mcp.servers` in the config.

## TUI basics

| Action | Key or command |
| --- | --- |
| Send a prompt | `Enter` |
| Add a newline | `Shift+Enter` |
| Cycle modes | `Tab` |
| Open the session manager | `Ctrl+S` or `/sessions` |
| Open the command palette | `Ctrl+P` |
| Open help | `Ctrl+G` or `/help` |
| Expand or collapse activity and thinking | `Ctrl+O` |
| Expand one activity group | Click the `Activity` row |
| Scroll the transcript | Mouse wheel, `PageUp`, `PageDown` |
| Stop the current turn | `Esc` twice |
| Browse and search models | `/models` |
| Add, edit, or delete providers | `/connect` |
| Inspect snapshots | `/timeline` |
| Undo or redo file changes | `/undo`, `/redo` |
| Split the diff into commits | `/commit` |
| Show token and cost stats | `/stats` |

The current mode, model, context usage, and session cost are shown in the header. The footer under an answer shows the mode, model, and generation speed.

Approval dialogs use Up and Down, Enter, and Esc. Question dialogs add Space for multi-select and a text field for a custom answer.

Mouse clicks require a terminal that sends SGR mouse events. `Ctrl+O` expands or collapses activity and thinking without a mouse.

## Building a binary

Create a single executable for the current platform:

```bash
bun run build:binary
```

The output is:

```text
./orchivox
```

The build stubs Ink's optional React DevTools import, so the compiled binary does not need `react-devtools-core` at runtime. React DevTools is not available in the binary. Use `bun run start` when you need it.

Run it directly:

```bash
./orchivox --help
./orchivox
```

The binary is compiled for the operating system and CPU architecture of the machine that runs the build. Run the build on each target platform when you need separate binaries.

## Development

Run the type checker:

```bash
bun run typecheck
```

Run the test suite:

```bash
bun test
```

Run a single test file:

```bash
bun test tests/system-prompt.test.ts
```

The project runs TypeScript directly through Bun. There is no separate transpile step for local development.

## Project layout

```text
src/agent/       orchestration, prompts, permissions, tasks, subagents
src/tui/         terminal UI, composer, transcript, modals, themes
src/tools/       file, search, edit, shell, web, image, background tools
src/provider/    provider adapters, routing, stream rules, model catalog
src/ide/         LSP, DAP, AST compression, code intelligence
src/memory/      SQLite sessions, rules, hindsight memory
src/vcs/         Git worktrees, snapshots, atomic commits
src/api/         OpenAI, Anthropic, OpenAPI, and task endpoints
scripts/         build scripts
bin/             command launcher
.agent/          local config, rules, skills, plugins, snapshots, state
assets/          logo and README image
```

## Troubleshooting

### `no model assigned for role`

Add a provider under `providers` and assign the missing role in `.agent/config.yaml`. The main role is `roles.main_model`.

### `401` or `missing or invalid api key`

Check the provider key in `.agent/secrets.yaml` or the environment variable used by the config. For the gateway, check `inbound_server.api_key`.

### Ollama is not reachable

Confirm that Ollama is running on `http://127.0.0.1:11434` and that the model is installed:

```bash
ollama serve
ollama list
ollama pull qwen2.5-coder:7b
```

### Worktrees or snapshots fail

Worktrees, snapshots, and `/commit` need a Git repository. Make at least one commit before using them.

### LSP diagnostics are missing

Install the language server for your project and confirm its command is available on `PATH`. LSP is optional. The agent still works without it.

### The local model ignores tools

Use a model with reliable tool calling. Small local models can stop after one tool call or produce a plan instead of an answer. A stronger hosted model is usually better for long repository tasks.

## Status

Orchivox is at version `0.1.0`. It is a working terminal runtime, not a hosted service. The local model path is useful for development and offline tests. For long tasks, use a model with strong tool calling and a context window that matches the repository size.
