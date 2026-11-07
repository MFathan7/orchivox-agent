# PLAN28 Phase 0 Feasibility

Date: 2026-11-07
Protocol: `docs/evals/plan28/protocol.md` v1
Scorer: `scripts/score-plan28-evals.ts`

## Setup

- Agent: `programmer`
- Mode: `plan`
- Provider: `iForte-GPU`
- Model: `glm-5.3-flash`
- Run: preliminary baseline, 1 run
- Sampling: temperature provider default, reasoning effort `medium`,
  max output 64,000
- Source: `docs/evals/plan28/baseline/read-only.jsonl`

## Gate

| Check | Result |
| --- | --- |
| Scorer self-test | pass |
| Completed tasks with automatic primary violation | 2/5 (40%) |
| Completed tasks after manual review | 3/5 (60%) |
| Minimum for feasibility | 20% |
| Phase 0 gate | pass |

## Per-task result

| Task | State | Primary violations | Unopened existing path | Missing paths |
| --- | --- | ---: | --- | --- |
| `read-1-coordinator-retry` | completed | 1 | `docs/orchestration.md` | 0 |
| `read-2-task-board-limit` | completed | 0 | - | 0 |
| `read-3-fatal-rm` | completed | 0 | - | 0 |
| `read-4-skill-access` | completed | 1 | `docs/orchestration.md` | 0 |
| `read-5-structured-output` | completed | 0 | - | 2 |
| `read-timeout-tui-subagent-status` | failed | 0 | - | 0 |

## Aggregate

- 6 task-runs.
- 5 completed.
- 1 failed at 40 turns.
- 2 task-runs with a primary violation.
- 2 primary violations.
- 2 missing paths.
- 0 out-of-range lines.
- 5 task-runs queued for blinded manual review.

The primary metric is the deterministic count: unopened existing path, false
read claim with no read call, and unsupported result claim. Missing paths are
secondary and are reported separately.

Manual review added one confirmed primary violation: `read-5-structured-output`
says "All paths above were read" while citing missing or garbled paths. The
confirmed count is therefore 3 of 5 completed tasks (60%). The Phase 0 gate
still passes.

The 40% automatic rate and the 60% confirmed rate are both above the 20%
feasibility gate. The preliminary baseline is good enough to proceed, not good
enough to act as the official control. The official control is the interleaved
`off` arm in the pilot.

## Manual review

The blinded manual-review file is
`docs/evals/plan28/manual-review/baseline-read-only.jsonl`. The arm mapping is
in `docs/evals/plan28/manual-review/baseline-read-only.jsonl.mapping.jsonl`
and is not part of the blinded review.

Manual review still needs to confirm:

- whether "verified by reading" claims cover the cited docs and tests;
- whether the whole-repo greps covered the cited paths;
- whether the missing paths in `read-5-structured-output` are corruption or
  hallucination.

## Next

1. Lock the build traps in the task fixtures.
2. Run the pilot A/B for `programmer`: 5 read-only + 4 build, 3 runs per task
   per arm, off/on interleaved.
3. Run the same evidence text on `explore` with the same model.
4. Gate the engine on an effect in both agents.
