# Workflow fixture

`src/index.ts` exposes the preferences and search helpers. The project has no dependencies.

- `src/preferences.ts` bounds finite page sizes to 1..100 and uses 20 for non-finite input.
- `src/search.ts` returns matching record ids in input order, ignoring query case and surrounding whitespace. An empty query returns all ids.
- `verify.ts` exercises both contracts with `bun run verify.ts`. Its failures are intentional in the starting fixture.

Keep changes inside the two helper files when fixing these behaviors. Leave the verifier and entry point intact.
