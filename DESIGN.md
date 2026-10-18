# Design Direction: Orchivox TUI

Transcribed from the project owner's answers. The owner is the author of this
direction; the agent only formatted it.

## Identity

- Calm and focused.
- Priority is clarity and reading speed.
- Reference feel: Linear, GOV.UK.

## Personality

- Quiet, low decoration, no shouting.
- One focal point per screen.
- Every visual element has a job. Remove it when it has none.

## Dials

- ENERGY 1
- RHYTHM 1
- MOTION 1

## Palette

- Keep the four presets in `src/tui/theme.ts`: `tokyonight`, `catppuccin`,
  `gruvbox`, `monochrome`.
- Default preset stays `tokyonight`.
- Every color comes from the theme. No chalk color names, no hard-coded hex
  outside `theme.ts`.

## Typography and glyphs

- Box-drawing plus a small glyph set: `●`, `○`, `◆`, `❯`.
- The logo stays small; the compact variant is used in the header.
- No color emoji.

## Language

- English for every label, message, error, and help text.

## Layout rules

- The prompt composer is the single focal point.
- At most one accent border on screen. Prefer spacing and rules over nested
  borders.
- Every interactive element has a real action.
- Every data view has an explicit empty state.
