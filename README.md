<p align="center">

  <img src="https://raw.githubusercontent.com/MFathan7/orchivox-agent/main/assets/Orchivox%20Agent.jpeg" alt="Orchivox Agent logo" width="760" />

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
- [Installation](#installation)
  - [npm, npx, and Bun](#npm-npx-and-bun)
  - [First run](#first-run)
  - [Source checkout](#source-checkout)
  - [Updating Orchivox](#updating-orchivox)
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

The terminal interface is the main entry point. It shows the mode, active model, context usage, session cost, tool activity, and the final answer in one place. Reads, searches, and commands are grouped into a single `Activity` row. Press `Ctrl+O` to open it.

The same agent can run without the TUI:

- A headless prompt for scripts and CI.
- An HTTP gateway with OpenAI-compatible and Anthropic-compatible endpoints.
- An MCP server that exposes the agent tools over stdio.

Orchivox uses Bun for execution, TypeScript for the runtime, React and Ink for the terminal UI, and SQLite for session storage. Git is used for worktrees, snapshots, and commit splitting.

## Features

### Three working modes


| Mode      | What it is for                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------- |
| Plan      | Read-only inspection, architecture questions, and implementation plans. File changes are blocked. |
| Build     | Normal repository work. Workspace edits and safe commands run automatically unless a permission rule asks. |
| Ultrawork | Longer autonomous work with a todo list, task board, and subagents.                               |


Switch modes with `Tab`, `/plan`, `/build`, `/ultrawork`, or `/mode`.

The system prompt and terminal UI are English. Replies follow the language of the user's last message.

Use `/study` for a structured report about the current project. It reads project evidence from disk and asks for a report without editing files. Use `/review <file>` to review one file, or `/review <question>` to answer a code question from project evidence. These are explicit commands; a normal sentence that mentions study or review does not trigger them.

Plan mode can delegate read-only exploration to subagents. It discusses the plan in chat and writes a plan file only when you ask, as a `PLAN*.md` file in the active project directory. Build mode does not read or create plan files automatically.

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

Within a single turn, independent read-only tool calls also run concurrently, up to four at a time, and keep their original result order. Edits, shell commands, and interactive tools stay sequential.

When you reference a plan file in a build request, build reads it once and implements it instead of repeating the research it records. Larger exploration can go to read-only subagents so the main context stays small.

Use `/hub` to inspect workers and `/tasks` to open the task board. The agent can also create tasks directly when running in Ultrawork mode.

### Sessions you can resume

Sessions and messages are stored outside the project, under `$XDG_DATA_HOME/orchivox/projects/<project>-<hash>/` or `~/.local/share/orchivox/projects/<project>-<hash>/`. History, snapshots, and worker worktrees live beside that database. Set `ORCHIVOX_STATE_HOME` to override the base directory. Orchivox keeps the mode, model, token usage, and session cost. Tool activity is shown while a turn runs.

- `/sessions` opens the session manager and search.
- `/fork` branches a conversation from a selected turn.
- `/compact` compresses old context, and automatic compaction runs when the context window is nearly full.
- The answer footer shows the mode, model, and generation speed.

### Temporary files

Commands run with `TMPDIR` pointing at a managed directory under the Orchivox cache, for example `~/.cache/orchivox/tmp/run-<pid>-<id>`. Orchivox removes that directory when the runtime closes and removes stale `run-*` directories at startup. Files created by a command that hardcodes `/tmp` are outside this cleanup and are left alone.

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

Build mode starts at `low` reasoning when the model advertises it, so the first tool call arrives quickly. `default` sends no effort override and lets the provider decide, which can spend a long time reasoning before any action. Raise `modes.build.reasoning` to `medium` or `high` for work that needs deeper planning. Plan mode keeps its own setting.

### Context, rules, skills, and plugins

- Project instructions can come from `AGENTS.md`, `CLAUDE.md`, and the file named by the project directive, such as `.agent/agents/AGENTS.md`.
- Markdown rule files under `.agent/rules/` can be loaded by file pattern.
- Skills can add focused instructions and tool policies. A skill is advertised by name and description. The model loads the body with the skill tool when the task matches or the user mentions it. The body lives in the conversation and is reloaded after compaction. It is never kept in every system prompt.
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
- Build and Ultrawork run workspace edits and safe commands automatically. Add a permission rule in the config when an action needs approval.
- Permission rules can allow, deny, or ask for a tool or path before it runs.
- Reasoning counts as progress. There is no reasoning character limit by default; set `reasoning.max_silent_chars` only when you want a cost guard.
- A main-agent turn has no step cap by default. It runs until the model stops or you press Esc. Subagents keep an internal 40-step cap.
- The gateway binds to `127.0.0.1` by default. Put it behind a trusted proxy if you need remote access.
- Provider keys go to `~/.orchivox/secrets.yaml` with mode `0600`. If a project keeps its own `.agent/secrets.yaml`, that file is ignored by Git.

## Requirements

- Node 20 or newer for `npx`, `npm install -g`, and the launcher.
- Bun 1.1 or newer only when running from source or rebuilding a binary.
- A Git repository for worktrees, snapshots, and `/commit`. Other features can run outside Git, but those features need it.
- A model provider:
  - Ollama running locally, or
  - an API key for OpenAI, Anthropic, OpenClaude, or OpenRouter.
- Optional: language servers such as `typescript-language-server`, `pylsp`, `rust-analyzer`, or `gopls`.

## Installation

The npm package is a small launcher. On first run it downloads the verified
standalone binary for your platform. Bun is not required for the npm path.

### npm, npx, and Bun

```bash
npx orchivox@latest
# or
npm install -g orchivox
orchivox install
# or
bun add -g orchivox
```

`npx orchivox@latest` runs the installer, then starts the TUI. Use
`npx orchivox@latest install` to stop after installation.

Supported assets:

| Platform | Asset |
| --- | --- |
| Linux x64, glibc | `orchivox-linux-x64.gz` |
| Linux arm64, glibc | `orchivox-linux-arm64.gz` |
| macOS Intel | `orchivox-darwin-x64.gz` |
| macOS Apple Silicon | `orchivox-darwin-arm64.gz` |
| Windows x64 | `orchivox-windows-x64.exe.gz` |

Linux Alpine and other musl systems are not supported by the glibc assets.

### First run

The installer shows the version, platform, download size, and asks before
downloading. It stores the runtime under:

```text
~/.orchivox/versions/<version>/orchivox
~/.orchivox/bin/orchivox
~/.orchivox/install.json
```

Existing config, secrets, sessions, and snapshots stay unchanged. If
`~/.orchivox/bin` is not on `PATH`, the installer offers to add it. Use
`--no-path` to skip that prompt, or `--add-path` to add it without asking.

### Source checkout

Use this when you want to develop Orchivox itself:

```bash
git clone https://github.com/MFathan7/orchivox-agent.git
cd orchivox-agent
bun install
bun run start
```

You can also run the source entry point directly:

```bash
bun run src/index.ts
```

`bun link` links the launcher for development. `bun run install:global`
compiles the binary and records the source checkout for source updates.

### Updating Orchivox

```bash
orchivox update --check         # check without changing files
orchivox update                 # check, ask, then install
orchivox self-update            # alias for update
orchivox update --yes           # non-interactive install
orchivox update --rollback      # return to the previous version
orchivox update --source        # update a source checkout
orchivox update --check --json  # machine-readable check
```

Managed updates download `latest.json`, verify its Ed25519 signature, verify
the asset SHA-256, validate the new binary, and swap it atomically. The previous
version is kept for rollback. Interactive updates default to No.

Check the installed version, install method, and update status anytime:

```bash
orchivox --version
orchivox doctor
```

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

Create `~/.orchivox/config.yaml` (or a project `.agent/config.yaml` when that project needs its own settings) so it points to a provider and models you can reach. The repository includes an example configuration. Replace the provider block and the roles, or use the minimal configuration below.

Start the terminal UI. If you installed from npm, run `orchivox`. From a source
checkout, run:

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

You can put provider keys in the secrets file next to the active config, for example `~/.orchivox/secrets.yaml`, instead of the main config:

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
3. Project config: `.agent/config.yaml`, only when the file already exists
4. Global config: `~/.orchivox/config.yaml`
5. Empty defaults

A project config wins over the global one. New provider, role, and mode selections are written to the global files, so connecting a provider never creates `.agent/config.yaml` inside a project. The global secrets file is written with mode `0600`, and a new `~/.orchivox` directory is created with mode `0700`.

```bash
orchivox --config ~/.orchivox/config.yaml
ORCHIVOX_CONFIG=~/.orchivox/config.yaml orchivox
```

Provider API keys belong in the secrets file, not in tracked config. The config writer strips `api_key` from provider profiles before saving config. Run `bun run check:secrets` before pushing to verify tracked files do not contain key-like values and that `.agent/secrets.yaml` is ignored.

To move an existing project config to the global location:

```bash
mkdir -p ~/.orchivox && chmod 700 ~/.orchivox
mv .agent/config.yaml ~/.orchivox/config.yaml
mv .agent/secrets.yaml ~/.orchivox/secrets.yaml
chmod 600 ~/.orchivox/secrets.yaml
```

After that, every project without its own `.agent/config.yaml` uses the global file. Keep a project config only when that project needs settings that differ from your global defaults.


| Key              | What it controls                                                                |
| ---------------- | ------------------------------------------------------------------------------- |
| `providers`      | Provider profiles, base URLs, model lists, capabilities, pricing, and timeouts. |
| `roles`          | The main, fast, and advisor models.                                             |
| `modes`          | Per-mode model and reasoning overrides.                                         |
| `inbound_server` | Gateway port and API key.                                                       |
| `lsp`            | Language server commands and root markers.                                      |
| `mcp.servers`    | MCP servers to connect to.                                                      |
| `hooks`          | Commands to run before or after tools, and when a turn stops.                   |
| `sandbox`        | Reserved block. The config accepts it, but the runtime does not enforce it yet. |
| `compaction`     | Automatic context compaction thresholds.                                        |
| `websearch`      | Web search provider and enablement.                                             |
| `webfetch`       | Web fetch enablement and the converted-text cap (`max_chars`, default `24000`). |
| `prompt`         | System prompt style: `auto`, `full`, or `compact`.                              |
| `reasoning`      | Optional runaway reasoning character limit, and provider silence limit. Streaming reasoning counts as progress. |
| `limits`         | Optional session warning and per-turn token budget.                              |
| `skills`         | Optional per-skill body guard. `0` means no cap.                                 |
| `documents`      | Document read limits: characters, pages, file size, preview, cache spill, images. |


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
        max_input: 1047576
        max_output: 32768
        vision: true
        tool_calling: true
```

Use overrides when the provider does not expose the model metadata you need.
Orchivox reads limits from the models.dev catalog and probes Ollama, vLLM, LM
Studio, llama.cpp, and LiteLLM endpoints at startup. If a provider rejects a
request with a context-length error, Orchivox records the reported limit in
`~/.cache/orchivox/model-limits.json` and uses it on the next turn. Unknown
models fall back to 200,000 context tokens and 32,000 output tokens.

For a custom provider, Orchivox takes the limits of the provider the model
canonically belongs to. When that provider is absent, it keeps the smallest
limit across all catalog matches, because a proxy is more likely to enforce
less. Catalog output limits above 64,000 tokens are clamped unless
`model_capabilities` sets `max_output` explicitly.

Compaction runs before every provider request and can run mid-turn between tool
steps. Context use is the prompt the provider measured plus the completion it
produced, so thinking and tool calls count, and the trailing estimate starts
after that reply. The default buffer is 15% of the window with a 16,000 token
minimum on windows of 32,000 or more, plus a 2% safety margin. The summary is
paired with the most recent 15,000 tokens (`compaction.keep_tokens`). Set
`compaction.reserved` or `compaction.reserve_tokens` to pin the reserve, or use
`compaction.buffer_ratio` and `compaction.buffer_tokens` for a different split.
After compaction the same turn continues with the summary in place. Set
`compaction.precompute: true` to write the next summary in the background once
the measured context reaches 85% of the budget and at least 64,000 tokens. The
summary is held in memory and swapped in when compaction is due; if the older
messages changed, the turn falls back to a normal summary.

When `compaction.prune` is on, which is the default, old tool output is
replaced with a short marker before compaction. `prune_protect_tokens` keeps the
newest output (40,000 tokens by default) and `prune_min_tokens` sets the minimum
amount that must be freed before anything changes.

The system prompt lists available skills with their descriptions and locations,
but does not include their bodies. The `skill` tool loads the body, base
directory, and file sample into the conversation when the model calls it. A
loaded body is normal conversation content, so compaction can summarize it. The
summary keeps loaded skill IDs and paths, and the reload message lists those
IDs and paths again so the tool can restore any body the model still needs. The
tool returns the body again on every call. Skill bodies have no default
character cap; the model context
window is the limit. Set `skills.max_body_chars` to a positive value for an
optional guard, or leave it at `0` for no cap. A mention with `@skill` or
`/skill:<name>` adds a short hint to load that skill through the tool; the body
is not injected. If a skill asks the user to choose before work, the agent calls
the question tool first, even in build mode.

Use `read_document` for text, PDF, DOCX, and XLSX files. PDFs use `pages`, for
example `1-5` or `1,3,8`. An XLSX read without a sheet lists the sheets and
previews the first one; add `sheet` and `range` to get CSV for one range. A DOCX
becomes Markdown with headings and tables. Large extracts are written to a
private cache file and returned as a preview plus path; use `grep` or `read_file`
for the rest. Legacy `.doc` and `.xls`, macro-enabled `.docm` and `.xlsm`, and
files that expand past the ZIP budget are rejected. Images use `inspect_image`;
it resizes and compresses them to the `documents.image` limits (2000x2000 and a
5 MiB base64 cap by default) before the vision call, and the main model receives
a text report. Document limits live under `documents`: 24,000 characters, 20 PDF
pages, 200 XLSX rows, 50 columns, 40 MB file size, and 100 MB uncompressed ZIP
size by default.

Examples:

- PDF: `read_document` with `pages: "1-5"`.
- XLSX: `read_document` with `sheet: "Sales"` and `range: "A1:F50"`.
- DOCX or text: `read_document` with no extra fields.
- Image: `inspect_image` with `imagePath` and an optional `detail` level.

```yaml
documents:
  max_chars: 24000
  max_pages: 20
  max_sheet_rows: 200
  max_sheet_columns: 50
  max_file_mb: 40
  max_uncompressed_mb: 100
  preview_chars: 4000
  spill_threshold_chars: 24000
  image:
    auto_resize: true
    max_width: 2000
    max_height: 2000
    max_base64_bytes: 5242880
```

Every turn that ends with an error, an abort, a reasoning stall, a turn limit,
or an explicit step cap writes a system message to the session and a line to
`~/.cache/orchivox/errors.log`. `/stats` shows the last turn outcome.

Set `ORCHIVOX_USAGE_LOG=1` to append one JSON line per provider request to
`~/.cache/orchivox/usage.log`. Each line records the prompt estimate, the
provider-reported prompt and completion tokens, the context window, the prompt
budget, whether compaction ran, and how many tokens pruning freed. `/stats`
shows the last provider prompt next to the estimate and keeps the session total
separate. Set `limits.session_tokens` to warn once when a session passes that
total. Set `limits.turn_tokens` to stop a single turn after that many tokens;
the turn ends with a notice and the next message can continue the work.

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

### Version, diagnostics, and updates

```bash
orchivox --version
orchivox doctor
orchivox update --check
orchivox update
orchivox update --rollback
```

`--version` shows the installed version, install method, channel, commit, entrypoint, and whether the working tree is dirty. `doctor` also shows which config file wins, the secrets file, the session database, terminal details, and the latest release status when it can reach the manifest.

Managed `update` verifies the signed manifest and the asset checksum, then keeps the previous version for rollback. Source `update --source` refuses to run on a dirty working tree so local changes are never overwritten. Use `--yes` for non-interactive updates.

Inside the TUI, `/about` shows the entrypoint and config source, `/doctor` shows diagnostics, and `/update` checks for a new release or source commit.

Set `ORCHIVOX_INPUT_DEBUG=1` before starting the TUI to log raw key sequences to `~/.cache/orchivox/input-debug.log`. This is useful when a terminal reports Enter or Shift+Enter differently.

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


| Action                                   | Key or command                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Send a prompt                            | `Enter`                                                                 |
| Add a newline                            | `Shift+Enter`, `Alt+Enter` / `Option+Enter`, `Ctrl+J`, or `\` + `Enter` |
| Cycle modes                              | `Tab`                                                                   |
| Open the session manager                 | `Ctrl+S` or `/sessions`                                                 |
| Open the command palette                 | `Ctrl+P`                                                                |
| Open help                                | `Ctrl+G` or `/help`                                                     |
| Expand or collapse activity and thinking | `Ctrl+O`                                                                |
| Scroll the transcript                    | Mouse wheel, `PageUp`, `PageDown`                                       |
| Stop the current turn                    | `Esc` twice                                                             |
| Browse and search models                 | `/models`                                                               |
| Add, edit, or delete providers           | `/connect`                                                              |
| Inspect snapshots                        | `/timeline`                                                             |
| Undo or redo file changes                | `/undo`, `/redo`                                                        |
| Split the diff into commits              | `/commit`                                                               |
| Show token and cost stats                | `/stats`                                                                |


The current mode, model, context usage, and session cost are shown in the header. The window title follows the active session title, so a new chat switches from `Orchivox - <project>` to the first message. The footer under an answer shows the mode, model, and generation speed. During a turn, the live line shows the current step, what is running, elapsed time, and finished tool count, for example `Step 3 · Running command · 2s · 2 tools`. The step number counts provider requests inside the current user turn and is hidden on step 1.

Approval dialogs use Up and Down, Enter, and Esc. Question dialogs add Space for multi-select and a text field for a custom answer.

Mouse wheel scrolling requires a terminal that sends SGR mouse events. `Ctrl+O` expands or collapses activity and thinking without a mouse.

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

The public repository does not include the private test suite. CI checks the
type checker, launcher build, package contents, and tracked secrets.

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
src/installer/   launcher, installer, signed manifest, updater, rollback
scripts/         build, release, signing, and maintenance scripts
bin/             launcher and development entry point
.agent/          optional project config, rules, skills, plugins, commands
assets/          logo and README image
```

## Troubleshooting

### Installer download, checksum, or signature fails

The installer verifies the Ed25519 signature of `latest.json` and the SHA-256
of the downloaded asset. A failure means the release metadata or download was
altered, or the network returned an incomplete file. Retry with a stable
connection. If the signature check fails repeatedly, do not bypass it. Report
the release and the exact error.

Behind a proxy, use a network-level proxy or set `ORCHIVOX_MANIFEST_URL` to a
reachable mirror that serves compatible asset URLs. Environment proxy support
and offline installs are not implemented yet.

### `orchivox` is not on PATH

The installer can add `~/.orchivox/bin` to your shell config when you approve
it. To do it manually:

```bash
export PATH="$HOME/.orchivox/bin:$PATH"
```

Add the line to your shell profile to keep it. On Windows, add
`%USERPROFILE%\.orchivox\bin` to the user PATH.

### macOS Gatekeeper or Windows SmartScreen

The current binaries are not code signed. macOS may ask for confirmation, and
Windows SmartScreen may show an unknown publisher warning. Verify the release
checksum and signature before allowing the binary to run. Code signing and
notarization are planned separately.

### Linux Alpine or musl

The published Linux assets are built for glibc. Alpine and other musl systems
are not supported by those assets. Use a glibc distribution or build from
source.

### Update or rollback fails

`orchivox update --check` is read-only. If the update itself fails, the current
binary is left in place. Use `orchivox update --rollback` to return to the
previous version. The previous version is kept under `~/.orchivox/versions/`.

### `no model assigned for role`

Add a provider under `providers` and assign the missing role in `~/.orchivox/config.yaml` or the active project `.agent/config.yaml`. The main role is `roles.main_model`.

### `401` or `missing or invalid api key`

Check the provider key in `~/.orchivox/secrets.yaml`, the project `.agent/secrets.yaml`, or the environment variable used by the config. For the gateway, check `inbound_server.api_key`.

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

### `reasoning_only`

The model returned only internal reasoning and no answer. Retry, lower the thinking effort for that model, or switch to a model that emits a final answer. The reasoning stays in the collapsed `Thought` block for inspection.

### `reasoning_stall`

The provider sent no event for `reasoning.max_silent_seconds` (default `180`), so the turn was treated as a dead stream. Before stopping, the agent makes one recovery request that asks the model to act with lower thinking. The turn stops only when the recovery also fails.

The optional character limit `reasoning.max_silent_chars` defaults to `0`, which disables it. Set a positive value only when you want a hard cost guard for runaway reasoning. A long reasoning pass that keeps streaming is not interrupted by the time limit.

## Status

Orchivox is at version `0.3.0`. It is a working terminal runtime, not a hosted service. The local model path is useful for development and offline tests. For long tasks, use a model with strong tool calling and a context window that matches the repository size.