# Skills

Orchivox loads skills from `.agent/skills/`. A skill is a Markdown file with
YAML frontmatter that tells the agent when to use it and what to do.

## Layout

Two layouts are supported:

```
.agent/skills/pdf/SKILL.md
.agent/skills/notes.md
```

The directory form is preferred because a skill can keep reference files next
to its `SKILL.md`.

Orchivox scans these roots, in order:

```
.agent/skills/                  (project, highest precedence)
skills/                         (project)
~/.agents/skills/               (global)
$ORCHIVOX_SKILLS_PATH           (extra roots, colon-separated)
```

`ORCHIVOX_SKILLS_PATH` accepts absolute paths and `~` expansion. Other
platform folders such as `.claude/skills/` or `.opencode/skills/` are not
scanned automatically; add them through `ORCHIVOX_SKILLS_PATH` if needed.
When two skills share a name, the first root wins (project over global).
The `/skills` panel shows each skill's scope (`project`, `global`, `custom`).

## Frontmatter

```md
---
name: pdf
description: Extract text and tables from PDF files.
when_to_use: When the user attaches a PDF.
allowed_tools:
  - read_file
  - shell
model_role: main
---

# PDF workflow

1. Inspect the file.
2. Extract the text.
3. Summarize the tables.
```

Only `name` and `description` are required in practice. When they are omitted,
the first heading and the first paragraph are used.

| Field | Purpose |
| --- | --- |
| `name` | Identifier used by the `skill` tool and `$` autocomplete. |
| `description` | One line shown in the system prompt index and `/skills`. |
| `when_to_use` | Extra trigger guidance shown when the skill is loaded. |
| `allowed_tools` | Restricts tools for the rest of the turn after the skill is loaded. |
| `model_role` | Advisory role for the skill: `main`, `fast`, or `advisor`. |

## Tool restrictions

Once a skill with `allowed_tools` is loaded, the orchestrator limits the rest
of the turn to those tools plus the always-allowed set: `skill`, `skill_list`,
`todo_write`, `todo_read`, `read_file`, `glob_files`, `grep_search`,
`json_query`, and `diagnostics_check`. Multiple skills union their lists. An
empty list is strict and leaves only the always-allowed set. Omit
`allowed_tools` to keep the full tool set. The restriction resets on the next
user turn. Network and vision tools such as `web_search` and `inspect_image`
must be listed explicitly.

Attempts to call a blocked tool return a tool error instead of running it.

## How the agent uses a skill

1. On startup, `SkillRegistry` builds a compact index of names and
   descriptions. Only the index goes into the system prompt.
2. When a task matches a skill, the model calls the `skill` tool with the
   exact name. The tool returns the full body and metadata.
3. The model follows the loaded instructions. Full skill bodies never enter
   the system prompt unless they are loaded.

## In the TUI

- `/skills` opens the skill panel with a searchable list and a body preview.
- `$name` in the composer opens skill autocomplete.
- Press `r` in the panel to reload skills after editing files on disk.
