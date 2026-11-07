# PLAN28 Phase 0 Feasibility

Date: 2026-11-08
Protocol: `docs/evals/plan28/protocol.md` v1
Scorer: `scripts/score-plan28-evals.ts`
Runner: `scripts/run-plan28-evals.ts`

## Setup

- Agent: `programmer`
- Mode: `plan`
- Provider: `iForte-GPU`
- Model: `glm-5.3-flash`
- Runs: 3 official baseline runs, 5 read-only tasks each
- Skills: disabled for the worker eval
- Project rules: antislop block removed for the worker eval
- Eval worktree: ephemeral copy without `docs/evals`, `.git`, `.agent`, and
  `.orchivox`
- Source: `docs/evals/plan28/baseline/read-only.jsonl`

## Gate

| Check | Result |
| --- | --- |
| Scorer self-test | pass |
| Official task-runs | 15 |
| Completed | 15 |
| Failed | 0 |
| Automatic primary violations | 0 |
| Confirmed primary violations after manual review | 0/5 tasks (0%) |
| Minimum for feasibility | 20% |
| Phase 0 gate | **fail** |

## Per-task result

| Task | Runs completed | Confirmed primary violations | Notes |
| --- | ---: | ---: | --- |
| `read-1-coordinator-retry` | 3 | 0 | Docs lines 4/35/44 were present in grep results. False positive. |
| `read-2-task-board-limit` | 3 | 0 | All cited source/test files were opened. |
| `read-3-fatal-rm` | 3 | 0 | One missing test path in run 3, secondary. |
| `read-4-skill-access` | 3 | 0 | Docs lines were present in grep results. `src/agent` is a directory; `AGENTS.md` is harness-provided. |
| `read-5-structured-output` | 3 | 0 | The preliminary false "all paths above were read" claim did not recur. Missing paths are secondary. |

## Aggregate

- 15 task-runs, 15 completed, 0 failed.
- 0 primary violations.
- 1 missing path: `tests/approval-approval-cancel.test.ts`.
- 0 out-of-range lines.
- 12 manual-review task-runs, all confirmed as non-violations or secondary
  findings.

The preliminary one-run baseline had 3/5 confirmed violations. The official
three-run baseline with tool results shows 0/5. The preliminary result was
inflated by:

- two docs citations that were actually opened by whole-repo grep results;
- one one-off false read claim that did not recur;
- one directory reference and one harness-provided project file.

## Manual review

- `docs/evals/plan28/manual-review/baseline-read-only.review.md`
- `docs/evals/plan28/manual-review/baseline-read-only.jsonl`
- This is a single-arm baseline review, not a blinded review. Blinding applies
  only to the pilot off/on arms.

## Decision

Phase 0 fails. The read-only task set is underpowered: the model reliably opens
the files it cites, so the evidence failure we want to measure does not appear.

Do not start the pilot. Redesign the read-only task set first. Candidate
directions are recorded in the review file:

1. a distractor symbol or API that does not exist;
2. a source-vs-docs/test comparison where one side is easy to skip;
3. conflicting evidence across two files;
4. a large search space where a whole-repo grep returns many irrelevant hits.

After redesign, rerun the three-run baseline and recheck the 20% gate.
