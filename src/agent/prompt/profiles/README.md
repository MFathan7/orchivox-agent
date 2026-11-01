# Model instruction profiles

Add a profile here when a model family needs instructions that the default
Orchivox prompt does not cover, and the behavior has been observed.

A profile has:

- `id`: stable name,
- `match.providerKind` and/or `match.modelPattern`,
- `mode`: `append` or `override`,
- `text`: native Orchivox instructions,
- `removeKeys`: optional prompt parts to drop.

Register the profile in `../profiles.ts` before the default profile. Add a
regression test for selection and rendering.

Do not copy proprietary provider prompt text. Write the profile for Orchivox.
