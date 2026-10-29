# Releasing Orchivox

This document covers the release pipeline for versioned binaries and the npm
launcher. Read it before creating a tag.

## Prerequisites

- Bun 1.4.4 or newer.
- GitHub CLI authenticated for the repository.
- Permission to create GitHub Releases.
- The `ORCHIVOX_RELEASE_SIGNING_KEY` repository secret.
- The `NPM_TOKEN` repository secret with permission to publish the `orchivox`
  package.

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

Add the private key to GitHub Actions:

```bash
base64 < ~/.config/orchivox/release-private.pem | tr -d '\n' \
  | gh secret set ORCHIVOX_RELEASE_SIGNING_KEY
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

## Release flow

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
