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

Press Shift+Tab to switch modes:

| Mode | Use it for |
| --- | --- |
| Plan | Inspect code, settle decisions, and agree on changes and success checks. Project files stay read-only. |
| Build | Implement the agreed scope and verify the result. Default for everyday changes. |
| Ultrawork | Carry larger tasks through several stages, track required work, and integrate workers when useful and permitted. |

Use Build for a focused bug fix; use Ultrawork for work such as an API change plus
its callers and verification. Both finish once the requested result is verified.
Plan files are optional and created only when requested; changing modes alone does
not approve implementation.

## Commands and shortcuts

| Command | Action |
| --- | --- |
| `/connect`, `/models` | Set provider and model routes. |
| `/sessions` | Resume a saved conversation. |
| `/undo`, `/redo` | Undo or restore file changes. |
| `/settings` | Change approvals, limits, delegation, and animations. |
| `/hub` | Inspect workers, results, errors, and pending merges. |
| `/mcp` | Open MCP setup: add/configure servers, inspect tools, enable/disable, reconnect, or remove. |
| `/stats` | View context, token usage, and estimated cost; scroll with the wheel or arrow keys. |
| `/turn-report` | Inspect the last turn's tools, timing, and delegation. |
| `/btw [question]` | Ask a side question or open its history. In the panel: `f` reply, `x` stop, Ctrl+X stop while editing, Escape close. Closing keeps the answer running; End follows new output. |
| `/queue`, Ctrl+Q | Open the queue: `e` edit, `x` cancel, Enter save, Esc discard edit, Ctrl+X cancel while editing. Use `r` to resume restored queues. |
| `/compact` | Summarize older conversation context. |
| Ctrl+O | Expand or collapse thought, tool output, and diffs. |
| Page Up / Page Down | Scroll chat; use End with an empty input to return to the latest message. |
| Escape twice | Stop the main turn and pause the queue. |
| `/help` | Show all commands and shortcuts. |

Queued work pauses after Stop, an error, or an incomplete turn. Open Ctrl+Q and press `r` to resume. Side answers continue independently. Timeline restores use the same work queue.

Paused work shows its reason above the input and in `/queue`. Invalid JSON tool
arguments trigger one bounded recovery request by default. Tools from the
rejected response are not executed. Set `limits.tool_argument_retries` to `0`
to disable recovery, or `1` or `2` to choose its limit. Recovery adds provider usage
and follows existing turn budgets; exhausted recovery leaves the queue paused.

If a connection failure ends the main turn, pending messages stay saved and
paused. Sending another message adds it to the queue; it does not resume it.
After reconnecting, `r` continues pending work. Resend the failed request if it
still needs completing; resuming does not replay it automatically.

Each `/btw` reply sends an extra request with conversation context, adding input and output tokens to session usage. Provider limits can reject it; the side panel shows the error without restarting the main task or switching providers. Costs use provider charges or configured prices; missing data is marked incomplete.

## Subagents

The main agent can delegate focused tasks to workers with separate contexts. Write workers use isolated Git worktrees by default; their changes are reviewed before merging.

In `/settings`, choose a Delegation policy:

- `requested`: delegate only when explicitly requested.
- `balanced` (default): weigh independent work against setup cost.
- `eager`: dispatch independent parts during initial scoping and keep working on a part that can proceed alongside them.

Coordinator **On demand** makes the optional planning tool available. Neither setting guarantees a worker on every request. Small tasks can stay with the main agent.

Configure Fast and Advisor roles in `/models` with Ctrl+R for specialists that require them. They may use the same model as Main. Up to four workers run concurrently by default; excess workers queue.

Set `limits.worker_steps` in `.agent/config.yaml` to adjust the per-worker model step budget (default `40`, `0` disables it). Workers that reach the step or token budget keep their isolated worktree for review.

Use `/hub` to inspect workers. If none appear, `/turn-report` distinguishes worker tools offered from workers actually called. Project settings can override global settings.

## Settings worth checking

- Build and Ultrawork default to **Safer Build** approvals for credentials, destructive actions, database commands, and code execution.
- New configurations allow 100 foreground tool calls and 20 minutes per turn. Change **Turn tool limit** and **Turn time limit** in Settings; `0` disables a limit. Existing explicit zeroes stay disabled.
- **Background titles** and **Idle recap** make extra model requests. Disable either in Settings to avoid those requests.
- **Animations** controls activity indicators. Thought stays collapsed by default; progress narration remains visible.

Open `/theme` and press Tab to switch between **Layout** and **Colors**.
Choose **Orchivox** for framed prompts and tool panels, **Claude Code** for a
tool timeline and animated status, **Codex** for numbered diffs and a work
status with active tool details, or **Pi** for a spinner, inline tool progress,
and a context footer. All four layouts share the same chat width and keyboard shortcuts.
Press `Ctrl+B` to toggle the sidebar on wide terminals.

Arrow keys or the wheel browse. Enter applies the selection and Esc closes the
picker. Layout and color are saved separately, so every layout can use any
compatible palette. **Auto** follows the terminal background. Use
`/theme <color>` to apply a color directly.

Consecutive reads and searches share an activity group.
Successful file reads and image inspections show their paths.
File moves show paths without content diffs; failures remain readable.
Ctrl+O expands other tool output and code diffs. The worker line separates running work from queued
or preparing workers; the main status identifies a worker it is waiting for.

Tool activity distinguishes empty, partial, cancelled, and unavailable results.
Large results and tool images use stored artifacts, so reopening a session keeps
their references. Models without vision receive a clear image-delivery notice.
LSP/compiler failures are distinct from empty results. Local symbol/hover
fallbacks show their source and limited scope; interrupted multi-file edits
report confirmed changes and uncertain or unattempted files.

The TUI updates changed rows and keeps the newest pending frame when output slows.
Streaming and activity animations share adaptive pacing, up to 30 FPS.

Independent tools can run together in Plan and Build, for both the main agent and workers. `tools.max_concurrent` sets the per-agent limit (default `4`, range `1–16`; `1` runs sequentially). Persistent shell calls and edits run in order. Independent shell calls can opt into separate cwd/environment snapshots with `isolatedState: true`; workspace files remain shared. Provider/model capabilities can restrict parallel execution.

The agent can inspect directories through `read_file` and SQLite schema or rows through `read_database`. SQLite inspection is read-only, paginated, and time-limited, including in Plan mode.

## Skills and MCP

Open `/skills` to inspect skill IDs, source files, and loading issues. Orchivox
finds `.agents/skills`, `.agent/skills`, and `skills` from the current folder up
to the repository root, plus `~/.agents/skills` and custom roots. When names
conflict, choose an exact ID; Tab shows issues, Enter opens details, and `r`
reloads. Invoke a skill with `/skill:<id>`, `$<id>`, or `@<id>`.

Details also show invocation policy and dependency availability. Disabled skills
cannot load; explicit-only skills need a direct invocation. Supported sidecar
policy and dependencies are read from `agents/openai.yaml`. Missing tools or
executables are reported without installing software or connecting servers.

Loaded status requires the complete current skill body, through `skill` or
verified `read_file` pages. Resume reuses it; changed or compacted content can be
reloaded when needed. Reading metadata alone does not invoke an explicit-only
workflow. Skill reports remain visible.

Skills provide instructions; their CLI dependencies or MCP servers must also be
available. Portable `allowed-tools` does not restrict the tool catalog. Native
`allowed_tools` supports exact names and `*` patterns such as `mcp__browser__*`;
mode permissions and worker isolation still apply.

Use `/mcp` to open its setup menu. Arrow keys or the wheel select a server;
Enter shows tools, `a` adds, `c` configures, `e` toggles enabled, `r` reconnects,
and `x` asks before removing. Setup asks for name, transport, URL or executable,
and arguments; Enter confirms before saving. Escape cancels.

Headers and environment settings remain in config and are preserved by the form.
Enabled servers connect in the background during TUI startup, up to four at
once. Progress updates stay in the existing tool activity. Cached lists are
marked stale when disconnected and never enable tools. Connections retry at
most twice; interrupted tool calls are never replayed automatically.
Tune `mcp.lifecycle`: `connect_concurrency` (4), `connect_timeout_ms` (10000),
`request_timeout_ms` (60000), `reconnect_attempts` (2), `reconnect_delay_ms` (500),
`cache_ttl_ms` (300000), and `max_catalog_pages` (100). Reconnect manually with
`/mcp reload <name>` after fixing an unavailable server.

Slash commands still work: `/mcp tools <name>` lists connected tool names.
Add an HTTP server with `/mcp add <name> <url>`, or supply JSON for stdio/SSE:

```text
/mcp add browser {"command":"my-browser-server","args":[]}
```

Use the command of a server installed on your machine. `/mcp enable <name>`,
`disable <name>`, `remove <name>`, and `reload [name]` manage saved connections.
Connection changes wait for idle tasks; status is available during a turn.
Reload reads the current config file. PLAN keeps MCP tools unavailable; BUILD
and ULTRAWORK use their existing permission checks. MCP results retain text,
structured data, and resource references. Supported images reach vision models;
other models receive an explicit notice. Embedded binary files are saved as
artifacts, and unsupported content is reported. CLI `orchivox mcp` separately
exposes Orchivox tools as an MCP server.

For servers with resources or prompts, press `u` for resources, `t` for URI
templates, or `p` for prompts in `/mcp`. Use `n`/`b` for pages and Enter to open
one item. Template variables and prompt arguments use JSON. These remote
operations are unavailable in PLAN. Slash equivalents appear in `/mcp help`.

Select a text resource as a skill with `s` or `/mcp skill <server> <URI>`, then
invoke the returned skill ID. Selection lasts until disconnect or process exit;
loading follows normal skill policy and MCP permissions. Resources and prompts
are fetched on demand and do not become system instructions.

Press `i` in `/mcp` for authentication. Choose OS storage or memory only with
Tab, then Enter to sign in. Use `o` to open the browser, Escape to cancel,
`r` to refresh, or `x` to log out. OS storage needs an available, unlocked
credential backend; memory-only login lasts until exit. No plaintext fallback
is used, and managed OAuth tokens stay out of project config.

Disconnect keeps saved credentials. Logout removes local OAuth credentials from
available stores; service-side grants and manual headers/env are managed
separately. `/mcp login <server> native|session` opens the authentication menu.
Memory-only login keeps previously saved OS credentials until logout.

## Coding tools

Web tools search through configured Tavily, Brave, Exa, or Firecrawl credentials,
with DuckDuckGo as a fallback. `web_fetch` reads HTML, text, GitHub resources,
arXiv and PDFs. It does not run a page's JavaScript or operate a browser.
Search failures are reported separately from successful searches with no results.
`web_search` accepts `includeDomains`, `excludeDomains`, `startDate`/`endDate`
(YYYY-MM-DD), and `maxResults` (1–20). Domain/date filters use Tavily or Exa;
unsupported adapters are skipped without dropping filters. Brave continuation
returns a `page` argument when more results exist. Other adapters suggest
refining the query. Results include source URLs and coverage limits. Existing
configured counts above 20 are capped with a visible explanation.

- Find implementations from a description with `code_find`. Semantic search makes an additional metered model request; lexical search stays local.
- Search/edit TypeScript and JavaScript/Node.js syntax with `ast_search`/`ast_edit`. Python adds search/edit; Rust and Go add search only through optional parsers. Inspect `ast_search` with `operation: "capabilities"`. LSP adds server-supported actions and file-move previews.
- Read ZIP/TAR/TAR.GZ members and Jupyter notebook cells without extracting files or executing cells. Notebook edits preserve metadata and clear edited code-cell outputs.
- Use `github_read` with an explicit repository: `code_search` searches code, `run_jobs` lists jobs, `run_watch` observes Actions within a deadline, and `run_logs` reads failed-step logs. Requires authenticated `gh`; missing CLI/login/access is reported. Issue/PR operations remain available; Safer Build asks before publishing.
- Test JavaScript pages with `browser_session`; use `browser_read` for DOM/selectors, tabs, and screenshots. Launch uses a temporary Chromium profile; attach requires an owner-configured `browser.attach_url`.
- Debug through configured DAP adapters with `debug_session`; `debug_read` inspects status, stack frames, and variables. Disconnect preserves attached processes.
- Run persistent TypeScript/Python cells with `eval` in Build. Python requires an interpreter. TypeScript retains explicit `state` properties; Python retains top-level variables. State is temporary; timeout, cancellation, eviction, or restart can clear it.
- Use optional context checkpoints to replace exploratory model context with an evidence report. Saved history, file changes, and usage stay intact.

Python/Rust/Go AST search requires `ast-grep` >=0.50 on PATH (tested with
0.51.2). Install it separately, for example `npm install -g @ast-grep/cli`.
Python AST operations also require Python >=3.8. Restart Orchivox after installing
these dependencies. Rust/Go rewrites are explicitly unavailable; Python edits
are checked with the Python parser before writing. Orchivox does not install
parsers automatically or execute the source being inspected.

Browser tools require an installed Chromium/Chrome/Edge; set `browser.executable`
if discovery cannot find it. Debugging requires a separately installed adapter.
For Python with `debugpy` installed, configure:

```yaml
debug:
  adapters:
    python:
      command: python3
      args: ["-m", "debugpy.adapter"]
      launch_type: python
```

Restart after configuration changes. PLAN can inspect an existing session;
launch, attach, navigation and execution require BUILD/ULTRAWORK and follow
execution permissions. Safer Build asks for approval. Browser and debug sessions
are scoped to each chat/agent/workspace and expire after ten idle minutes.
Adapters and browsers are not installed automatically.

### SSH projects and Linux desktop

Configure these optional integrations in `.agent/config.yaml`, then restart:

```yaml
remote:
  hosts:
    staging:
      destination: my-ssh-alias
      root: /srv/project
      allow_write: false
desktop:
  enabled: false
```

`remote_read` lists, reads, hashes, and searches through OpenSSH/SFTP. File
operations require a host alias and root-relative `remotePath`; results keep
`ssh://` identities. Configure SSH keys/agent and verified `known_hosts` outside
chat. Unknown host keys are never accepted automatically. Local AST/LSP tools
do not inspect remote files.

Enable `allow_write` to offer `remote_edit`. Edits require the inspected file's
exact `expectedUri` and SHA256 `expectedHash`, plus server atomic-rename support.
Hash checks are optimistic, so concurrent writers remain possible. Interrupted
writes are never retried automatically. Remote edits are outside local Git/undo.

Set `desktop.enabled: true` for Linux AT-SPI access. Requires Python 3,
PyGObject, pyatspi, and the desktop session. `desktop_read` observes windows;
`desktop_control` operates accessible elements in an explicitly selected window
with identity rechecks. Applications must expose accessibility. Screenshots
require OS permission: direct capture needs the selected window already active;
explicit portal capture is labeled user-selected, with window identity unverified.

PLAN exposes observation only; remote writes and desktop controls follow
edit/execution permissions. Safer Build asks for approval. Desktop access is
disabled by default; Windows/macOS desktop backends are not implemented.

Eval defaults to eight kernels and ten minutes of idle retention. Set `tools.eval_max_kernels` and `tools.eval_idle_seconds` in `.agent/config.yaml`. Calls made through the code-tool bridge count toward the foreground tool limit.

## Context and usage

Older context is summarized when needed. The completed **Compacted** divider shows the saved summary. Saved sessions, usage totals, and file changes survive compaction.

Resume through `/sessions`. Compacted skill bodies reload when needed; browser,
debugger, SSH, desktop selections, and eval state must be opened again after a
restart. Integrations require their own installed dependencies and configuration.

The context meter uses the latest provider input plus output measurement; `~` marks an estimate. The total below an answer sums all foreground model requests in that turn, including input history sent repeatedly. It can exceed the context window.

Session usage also includes workers, compaction, titles, and recaps. Cost labels mean:

| Label | Meaning |
| --- | --- |
| `~$…` | Estimated cost from reported usage and known rates. |
| `partial ~$…` | Some recorded usage cannot be priced. |
| `cost n/a` | No usable cost is known. |

These estimates depend on provider reports and pricing; they are not invoices.

**Long-term memory** is Off by default, including for existing configs without `memory.enabled`. Enable it in `/settings` or set `memory.enabled: true` to let the agent save and recall project notes. Turning it off keeps saved notes, chat history, and compaction. Notes may become outdated; verify technical facts against current code.

Overflowing chat shows a scrollbar on the right. Scroll with the wheel, click or drag the bar, or use the keyboard. New replies show their completion date (`dd/MM/yyyy HH:mm`) and elapsed time, including tool work and approval waits.

Completed replies keep their tool history visible, including calls before the first progress message. Press Ctrl+O to expand image inspection reports.

On Linux/macOS, drag chat text and release to copy it. Clipboard helpers are tried first, with a terminal clipboard request as fallback. On Windows, use native terminal selection; Windows Terminal requires Shift+drag while app mouse input is active, then its Copy shortcut or right-click action.

## Update

```bash
orchivox update --check
orchivox update
```

Use `orchivox update --rollback` if an update fails. Inside the app, `/update`
checks for an update and offers **Update now** or **Later**. Restart Orchivox
after installation to use the new version.

The TUI checks for new releases in the background at startup and every six hours,
using a six-hour cache. A notice shows the update command; installation stays
manual. Offline checks stay quiet. To disable automatic checks, add to config:

```yaml
updates:
  check: false
```

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

## Status

Orchivox is at version `1.2.0`.
