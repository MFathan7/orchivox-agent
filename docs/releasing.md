# Releasing Orchivox

This document covers the release pipeline for versioned binaries and the npm
launcher. Read it before creating a tag.

For the short operational checklist, see [`RELEASING.md`](../RELEASING.md).

## Prerequisites

- Bun 1.4.4 or newer.
- GitHub CLI authenticated for the repository.
- Permission to create GitHub Releases.
- The `ORCHIVOX_RELEASE_SIGNING_KEY` environment secret on the `release`
  environment.
- The `NPM_TOKEN` environment secret on the `release` environment with
  permission to publish the `orchivox` package. The token must bypass 2FA,
  otherwise the workflow stops with `EOTP` because no authenticator is
  available on the runner. Use a granular token with "bypass 2FA" enabled, or
  an automation token.
- Reviewer access to the `release` environment. The publish job pauses until a
  reviewer approves the deployment.

Keep both secrets on the environment, not on the repository. Repository
secrets are available to any job in the repository, while environment secrets
are released only after an approval.

## Signing key

The release manifest is signed with Ed25519. Generate the keypair once on a
trusted machine:

```bash
bun run release:key generate
```

The command writes:

```text
~/.config/orchivox/release-private.pem   private key, mode 0600
release-public-key.pem                   local public key, ignored by Git
```

It also prints the public key fingerprint. Keep the private key offline and
never commit it.

Add the private key to the `release` environment:

```bash
base64 < ~/.config/orchivox/release-private.pem | tr -d '\n' \
  | gh secret set ORCHIVOX_RELEASE_SIGNING_KEY --env release
```

Copy the public key into `src/installer/release-public-key.ts` and commit that
source file. The standalone `release-public-key.pem` file is ignored by Git
and is not published.

If the public key is lost, derive it again from the private key:

```bash
bun run release:key public --private ~/.config/orchivox/release-private.pem \
  --out release-public-key.pem
```

Then update the constant in `src/installer/release-public-key.ts`.

## Release protection

The publish job is guarded by three controls:

- The job only runs when `github.repository` is `MFathan7/orchivox-agent`.
- It targets the `release` environment, which requires approval from
  `MFathan7` before the job starts.
- The `v*` tag ruleset blocks tag creation, updates, and deletion unless
  `MFathan7` bypasses it.

To approve a release, open the workflow run, choose `Review deployments`,
select `release`, and approve. The job then continues with the environment
secrets. `prevent_self_review` is off, so the owner can approve their own
deployment.

`main` is also protected: force pushes and deletions are blocked, including for
admins. Direct pushes stay allowed so the guided release can commit and push
without opening a pull request. The `test` workflow still runs on every push,
and the release workflow repeats the checks before publishing.

Store `NPM_TOKEN` as an environment secret:

```bash
gh secret set NPM_TOKEN --env release
```

Never store it as a repository secret. A repository secret is visible to any
job in the repository, including jobs started from a branch in the same
repository.

## Version

The tag and `package.json` version must match:

```text
tag:          v0.3.0
package.json: 0.3.0
```

`scripts/build-release.ts` rejects a mismatch. Bump the version and update the
lockfile before tagging.

## Local build

Build all five assets and an unsigned manifest:

```bash
bun run build:release --version 0.3.0
```

Output:

```text
dist/release/v0.3.0/
  orchivox-linux-x64.gz
  orchivox-linux-arm64.gz
  orchivox-darwin-x64.gz
  orchivox-darwin-arm64.gz
  orchivox-windows-x64.exe.gz
  latest.json
  SHA256SUMS
```

`dist/` is ignored by Git. Do not commit release assets.

To regenerate the manifest and checksums from existing assets, for example after
signing or copying assets:

```bash
bun run build:release --version 0.3.0 --manifest-only
```

To sign locally with a key file:

```bash
bun run build:release --version 0.3.0 --manifest-only \
  --signing-key ~/.config/orchivox/release-private.pem \
  --require-signature
```

## Guided release

Run the cross-platform wizard from the repository root:

```bash
bun run release
```

It works on macOS, Linux, and Windows. The script:

1. Asks which branch to release from.
2. Asks for the commit message.
3. Offers patch, minor, major, or a manual version.
4. Updates `package.json` and the README version line.
5. Rebuilds `bin/launcher.mjs`.
6. Runs typecheck, tests when present, the secret scan, and the pack check.
7. Commits, pushes the branch, creates the tag, and pushes it.
8. Watches the release workflow and reports the npm version.

Non-interactive runs:

```bash
bun run release -- --bump minor -m "Add session export"
bun run release -- --version 0.4.0 -m "Release 0.4.0" --yes
```

| Flag | Meaning |
| --- | --- |
| `--branch <name>` | Branch to release from, default current |
| `--create-branch` | Create the branch when it does not exist |
| `--allow-non-main` | Permit a tag from a branch other than `main` |
| `-m, --message <text>` | Commit message |
| `--version <x.y.z>` | Exact version |
| `--bump <kind>` | `patch`, `minor`, or `major` |
| `-y, --yes` | Accept defaults and skip confirmation |
| `--dry-run` | Print the plan without changing anything |
| `--no-checks` | Skip local checks |
| `--no-watch` | Do not wait for the release workflow |

The script refuses to reuse an existing tag or npm version. If the npm step
fails, it offers to publish locally and rerun the failed job when a terminal is
available. `--dry-run` is safe to run at any time.

After the tag push, the publish job waits for approval on the `release`
environment. Approve it from the workflow run page, or with:

```bash
gh run list --workflow=release.yml
gh run view <run-id> --web
```

## Release flow

The manual flow remains available:

1. Run `bun run typecheck` and `bun test`.
2. Bump `package.json` version.
3. Commit and push the version bump.
4. Create and push a tag:

```bash
git tag v0.3.0
git push origin v0.3.0
```

The `release` workflow then:

1. Resolves the version from the tag.
2. Runs typecheck, tests, and the secret scan.
3. Builds the five platform assets.
4. Runs `--version` smoke tests on native runners.
5. Regenerates and signs `latest.json`.
6. Creates or updates the GitHub Release.
7. Uploads binaries, `SHA256SUMS`, `latest.json`, and `latest.json.sig`.
8. Publishes the launcher package to npm with provenance.

The publish job waits for approval on the `release` environment before it can
read the signing key or the npm token.

The npm step is skipped when the version is already on the registry, and it
re-checks the registry before failing, so a publish from another machine does
not leave the run red.

Manual dispatch is available for a dry run:

```bash
gh workflow run release.yml -f version=0.3.0 -f dry_run=true
```

A dry run builds and signs but does not create a GitHub Release.

## Assets

| Asset | Platform |
| --- | --- |
| `orchivox-linux-x64.gz` | Linux x64, glibc |
| `orchivox-linux-arm64.gz` | Linux arm64, glibc |
| `orchivox-darwin-x64.gz` | macOS Intel |
| `orchivox-darwin-arm64.gz` | macOS Apple Silicon |
| `orchivox-windows-x64.exe.gz` | Windows x64 |

Linux Alpine and other musl systems are not supported by the glibc asset.

## Manifest

`latest.json` is served from:

```text
https://github.com/MFathan7/orchivox-agent/releases/latest/download/latest.json
```

It contains the version, channel, notes URL, and one asset entry per platform
with `url`, `sha256`, and compressed `size`. `latest.json.sig` is the base64
Ed25519 signature over the exact bytes of `latest.json`.

## Rollback

The installer keeps the previous version under `~/.orchivox/versions/`. Use:

```bash
orchivox update --rollback
```

If a release itself is wrong, delete or mark the GitHub Release as a draft, then
publish a new patch version. Do not rewrite an existing tag that users may have
downloaded.

## Troubleshooting

- Missing signing key: add the `ORCHIVOX_RELEASE_SIGNING_KEY` secret.
- Tag mismatch: make `package.json` and the tag agree, then retag.
- Smoke test fails: do not publish. Inspect the runner and the target binary.
- Asset missing: check the build matrix and the artifact path.
- Wrong checksum: regenerate `latest.json` and `SHA256SUMS` with
  `--manifest-only`, then upload again.
- `ReleaseAsset.name already exists`: the workflow creates the release as a
  draft and uploads one asset at a time. Rerun the job, or dispatch
  `release.yml` for the same version.
- npm `EOTP`: the `NPM_TOKEN` secret needs bypass 2FA.
- npm `E404` during publish: the token is missing or invalid. A placeholder
  value shows up unmasked in the job log; real secrets are printed as `***`.
