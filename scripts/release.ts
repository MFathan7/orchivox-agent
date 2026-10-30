#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const ROOT = resolve(import.meta.dir, "..");
process.chdir(ROOT);

const PACKAGE_PATH = join(ROOT, "package.json");
const README_PATH = join(ROOT, "README.md");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const WIN = process.platform === "win32";

const HELP = `usage: bun run release [options]

Guided release: branch, commit message, version, checks, commit, push, tag,
GitHub Release, and npm publish through the release workflow.

options:
  --branch <name>        branch to release from, default current branch
  --create-branch        create the branch when it does not exist
  --allow-non-main       allow a release tag from a branch other than main
  -m, --message <text>   commit message, default "Release <version>"
  --version <x.y.z>      exact version, must be greater than the latest tag
  --bump <kind>          patch, minor, or major, default patch
  -y, --yes              run without prompts, default branch and patch bump
  --dry-run              print the plan without changing anything
  --no-checks            skip typecheck, tests, secret scan, and pack check
  --no-watch             do not wait for the release workflow
  -h, --help             show this help

examples:
  bun run release
  bun run release -- --bump minor -m "Add session export"
  bun run release -- --version 0.4.0 -m "Release 0.4.0" --yes
`;

type BumpKind = "patch" | "minor" | "major";

type Options = {
  branch?: string;
  createBranch: boolean;
  allowNonMain: boolean;
  message?: string;
  version?: string;
  bump: BumpKind;
  yes: boolean;
  dryRun: boolean;
  checks: boolean;
  watch: boolean;
  help: boolean;
};

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, text: string) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = (text: string) => paint(1, text);
const dim = (text: string) => paint(2, text);
const green = (text: string) => paint(32, text);
const yellow = (text: string) => paint(33, text);
const red = (text: string) => paint(31, text);
const cyan = (text: string) => paint(36, text);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    createBranch: false,
    allowNonMain: false,
    bump: "patch",
    yes: false,
    dryRun: false,
    checks: true,
    watch: true,
    help: false,
  };

  let bumpProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inline: string | undefined;

    if (arg.startsWith("--") && arg.includes("=")) {
      const split = arg.indexOf("=");
      inline = arg.slice(split + 1);
      arg = arg.slice(0, split);
    }

    const value = (name: string) => {
      if (inline !== undefined) return inline;
      const next = argv[++index];
      if (!next) throw new Error(`${name} requires a value`);
      return next;
    };

    switch (arg) {
      case "--branch":
        options.branch = value("--branch");
        break;
      case "--create-branch":
        options.createBranch = true;
        break;
      case "--allow-non-main":
        options.allowNonMain = true;
        break;
      case "-m":
      case "--message":
        options.message = value("--message");
        break;
      case "--version":
        options.version = value("--version");
        break;
      case "--bump": {
        const kind = value("--bump");
        if (kind !== "patch" && kind !== "minor" && kind !== "major") {
          throw new Error("--bump must be patch, minor, or major");
        }
        options.bump = kind;
        bumpProvided = true;
        break;
      }
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-checks":
        options.checks = false;
        break;
      case "--no-watch":
        options.watch = false;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--":
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.version && bumpProvided) {
    throw new Error("use either --version or --bump, not both");
  }

  return options;
}

type Semver = [number, number, number];

function parseSemver(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function formatSemver(parts: Semver): string {
  return parts.join(".");
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`cannot compare versions ${left} and ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function bumpVersion(version: string, kind: BumpKind): string {
  const parts = parseSemver(version);
  if (!parts) throw new Error(`invalid version: ${version}`);
  if (kind === "major") return `${parts[0] + 1}.0.0`;
  if (kind === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

type ExecResult = { status: number; stdout: string; stderr: string };

function exec(
  command: string,
  args: string[],
  options: { capture?: boolean; allowFailure?: boolean; shell?: boolean } = {},
): ExecResult {
  const capture = options.capture ?? false;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: options.shell ?? false,
  });
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status !== 0 && !options.allowFailure) {
    const detail = (stderr || stdout).trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`,
    );
  }
  return { status, stdout, stderr };
}

function git(args: string[], allowFailure = false): ExecResult {
  return exec("git", args, { capture: true, allowFailure });
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: WIN && command.endsWith(".cmd"),
  });
  return (result.status ?? 1) === 0;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let readline: ReturnType<typeof createInterface> | undefined;

async function ask(label: string, fallback = ""): Promise<string> {
  readline ??= createInterface({ input: process.stdin, output: process.stdout });
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await readline.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

async function confirm(label: string, fallback = false): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  readline ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await readline.question(`${label} (${hint}): `)
  ).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

function currentBranch(): string {
  const result = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.stdout.trim();
}

function listBranches(): string[] {
  const result = git([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function latestTagVersion(): string | undefined {
  const result = git(["tag", "--list", "v*"]);
  const versions = result.stdout
    .split("\n")
    .map((line) => line.trim().replace(/^v/, ""))
    .filter((value) => parseSemver(value) !== null);
  if (versions.length === 0) return undefined;
  versions.sort(compareSemver);
  return versions[versions.length - 1];
}

function readVersion(): string {
  const text = readFileSync(PACKAGE_PATH, "utf8");
  const match = /"version"\s*:\s*"([^"]+)"/.exec(text);
  if (!match) throw new Error("package.json has no version field");
  return match[1];
}

function writeVersion(version: string): void {
  const text = readFileSync(PACKAGE_PATH, "utf8");
  const next = text.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
  );
  if (next === text) throw new Error("could not update package.json version");
  writeFileSync(PACKAGE_PATH, next, "utf8");
}

function writeReadmeVersion(version: string): void {
  if (!existsSync(README_PATH)) return;
  const text = readFileSync(README_PATH, "utf8");
  const next = text.replace(
    /(Orchivox is at version `)[^`]+(`)/,
    `$1${version}$2`,
  );
  if (next !== text) writeFileSync(README_PATH, next, "utf8");
}

function tagExists(tag: string): boolean {
  const local = git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], true);
  if (local.status === 0) return true;
  const remote = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true);
  return remote.status === 0 && remote.stdout.trim().length > 0;
}

function npmHasVersion(version: string): boolean {
  const result = exec(NPM, ["view", `orchivox@${version}`, "version"], {
    capture: true,
    allowFailure: true,
    shell: WIN,
  });
  return result.status === 0 && result.stdout.trim() === version;
}

async function selectBranch(options: Options): Promise<string> {
  const branches = listBranches();
  const current = currentBranch();

  if (options.branch) {
    if (branches.includes(options.branch) || options.createBranch) {
      return options.branch;
    }
    const remote = git(
      ["ls-remote", "--heads", "origin", options.branch],
      true,
    );
    if (remote.stdout.trim()) return options.branch;
    throw new Error(
      `branch ${options.branch} does not exist; pass --create-branch to create it`,
    );
  }

  if (options.yes) return current;

  console.log(`\n${bold("Branches")}`);
  const shown = branches.slice(0, 12);
  shown.forEach((branch, index) => {
    const marker = branch === current ? green(" (current)") : "";
    console.log(`  ${index + 1}) ${branch}${marker}`);
  });
  if (branches.length > shown.length) {
    console.log(dim(`  ... ${branches.length - shown.length} more`));
  }

  const answer = await ask("Choose a branch number or type a name", current);
  const asNumber = Number(answer);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= shown.length) {
    return shown[asNumber - 1];
  }
  return answer;
}

async function switchBranch(
  branch: string,
  options: Options,
): Promise<void> {
  const current = currentBranch();
  if (branch === current) return;

  const local = listBranches();
  if (local.includes(branch)) {
    exec("git", ["switch", branch]);
    return;
  }

  const remote = git(["ls-remote", "--heads", "origin", branch], true);
  if (remote.status === 0 && remote.stdout.trim()) {
    exec("git", ["fetch", "origin", branch]);
    exec("git", ["switch", "--track", `origin/${branch}`]);
    return;
  }

  const create =
    options.createBranch ||
    (!options.yes &&
      (await confirm(`Branch ${branch} does not exist. Create it from ${current}?`)));
  if (!create) throw new Error(`branch ${branch} does not exist`);
  exec("git", ["switch", "-c", branch]);
}

async function selectVersion(options: Options): Promise<string> {
  const current = readVersion();
  const latest = latestTagVersion();
  const base =
    latest && compareSemver(latest, current) > 0 ? latest : current;

  if (options.version) {
    const next = options.version.trim();
    if (!parseSemver(next)) throw new Error(`invalid version: ${next}`);
    if (compareSemver(next, base) <= 0) {
      throw new Error(`version must be greater than ${base}`);
    }
    return next;
  }

  const patch = bumpVersion(base, "patch");
  const minor = bumpVersion(base, "minor");
  const major = bumpVersion(base, "major");

  if (options.yes) return bumpVersion(base, options.bump);

  console.log(`\n${bold("Version")}`);
  console.log(`  current ${base}${latest ? dim(` (latest tag v${latest})`) : ""}`);
  console.log(`  1) patch  ${patch}`);
  console.log(`  2) minor  ${minor}`);
  console.log(`  3) major  ${major}`);
  console.log("  4) manual");

  const answer = await ask("Choose 1-4", "1");
  if (answer === "2") return minor;
  if (answer === "3") return major;
  if (answer === "4" || parseSemver(answer)) {
    const manual =
      answer === "4" ? await ask("Version (x.y.z)") : answer;
    if (!parseSemver(manual)) throw new Error(`invalid version: ${manual}`);
    if (compareSemver(manual, base) <= 0) {
      throw new Error(`version must be greater than ${base}`);
    }
    return manual;
  }
  return patch;
}

function printStatus(): void {
  const status = git(["status", "--short"]).stdout.trim();
  if (!status) {
    console.log(dim("  working tree is clean; only the version bump will be committed"));
    return;
  }
  console.log(status);
}

function runChecks(): void {
  const steps: Array<[string, string[]]> = [["typecheck", ["run", "typecheck"]]];
  if (existsSync(join(ROOT, "tests"))) {
    steps.push(["tests", ["test"]]);
  }
  steps.push(["secret scan", ["run", "check:secrets"]]);
  steps.push(["pack check", ["run", "pack:check"]]);
  steps.push(["whitespace", ["diff", "--check"]]);

  for (const [label, args] of steps) {
    console.log(`\n${cyan("==>")} ${bold(label)}`);
    if (label === "whitespace") {
      exec("git", args);
    } else {
      exec("bun", args);
    }
  }
}

type GhRun = {
  databaseId: number;
  headBranch: string;
  status: string;
  conclusion: string | null;
};

async function findRun(tag: string): Promise<GhRun | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = exec(
      "gh",
      [
        "run",
        "list",
        "--workflow=release.yml",
        "--limit",
        "20",
        "--json",
        "databaseId,headBranch,status,conclusion",
      ],
      { capture: true, allowFailure: true },
    );
    if (result.status === 0) {
      try {
        const runs = JSON.parse(result.stdout) as GhRun[];
        const match = runs.find((run) => run.headBranch === tag);
        if (match) return match;
      } catch {
        // Keep polling while the API response is incomplete.
      }
    }
    await sleep(3000);
  }
  return undefined;
}

function failedJobs(runId: number): string[] {
  const result = exec(
    "gh",
    ["run", "view", String(runId), "--json", "jobs"],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as {
      jobs?: Array<{ name: string; conclusion: string | null }>;
    };
    return (parsed.jobs ?? [])
      .filter((job) => job.conclusion === "failure")
      .map((job) => job.name);
  } catch {
    return [];
  }
}

async function watchRelease(
  tag: string,
  version: string,
  interactive: boolean,
): Promise<boolean> {
  if (!commandExists("gh")) {
    console.log(
      yellow(`gh is not installed. Watch the release at:\n  ${releaseUrl(tag)}`),
    );
    console.log(
      `Then check npm with: ${bold(`npm view orchivox@${version} version`)}`,
    );
    return true;
  }

  console.log(`\n${cyan("==>")} ${bold("waiting for release workflow")}`);
  const run = await findRun(tag);
  if (!run) {
    console.log(yellow("release workflow did not appear within 60 seconds"));
    console.log(`  gh run list --workflow=release.yml`);
    return false;
  }

  console.log(dim(`  run ${run.databaseId}`));
  const watch = exec("gh", ["run", "watch", String(run.databaseId), "--exit-status"], {
    allowFailure: true,
  });
  const ok = watch.status === 0;

  if (ok) {
    console.log(green(`\nrelease workflow passed`));
    if (npmHasVersion(version)) {
      console.log(green(`orchivox@${version} is on npm`));
      console.log(`  npx --yes orchivox@latest --version`);
    } else {
      console.log(
        yellow(
          `npm version is not visible yet; check: npm view orchivox@${version} version`,
        ),
      );
    }
    return true;
  }

  console.log(red(`\nrelease workflow failed`));
  console.log(`  gh run view ${run.databaseId} --log-failed`);

  const failed = failedJobs(run.databaseId);
  const npmStepFailed =
    failed.length === 0 || failed.includes("publish release");

  if (!npmHasVersion(version) && npmStepFailed && interactive && process.stdin.isTTY) {
    const publish = await confirm(
      `orchivox@${version} is not on npm. Publish it locally now?`,
    );
    if (publish) {
      try {
        exec(
          NPM,
          ["publish", "--access", "public", "--provenance=false"],
          { shell: WIN },
        );
        exec("gh", ["run", "rerun", String(run.databaseId), "--failed"]);
        await sleep(3000);
        const rerun = exec(
          "gh",
          ["run", "watch", String(run.databaseId), "--exit-status"],
          { allowFailure: true },
        );
        if (rerun.status === 0) return true;
      } catch (error) {
        console.log(yellow(`local npm publish failed: ${String(error)}`));
      }
    }
  } else if (!npmHasVersion(version) && npmStepFailed) {
    console.log(
      `  publish locally: ${bold("npm publish --access public --provenance=false")}`,
    );
    console.log(`  then rerun:     ${bold(`gh run rerun ${run.databaseId} --failed`)}`);
  } else if (failed.length > 0 && !npmStepFailed) {
    console.log(
      yellow(`fix the failing jobs first: ${failed.join(", ")}`),
    );
  }

  return false;
}

function releaseUrl(tag: string): string {
  const remote = git(["remote", "get-url", "origin"], true).stdout.trim();
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
  const repo = match ? match[1] : "MFathan7/orchivox-agent";
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!process.stdin.isTTY && !options.yes) {
    throw new Error("stdin is not a TTY; pass --yes for automation");
  }

  const inside = git(["rev-parse", "--is-inside-work-tree"], true);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new Error("not inside a git repository");
  }
  const remote = git(["remote", "get-url", "origin"], true);
  if (remote.status !== 0) throw new Error("git remote origin is missing");

  git(["fetch", "--tags", "--quiet", "origin"], true);

  const branch = await selectBranch(options);
  if (!options.dryRun) await switchBranch(branch, options);

  const releaseBranch = options.dryRun ? branch : currentBranch();
  if (releaseBranch !== "main" && !options.allowNonMain) {
    const allowed =
      !options.yes &&
      (await confirm(
        `You are releasing from ${releaseBranch}, not main. Continue?`,
      ));
    if (!allowed) {
      throw new Error("release from main, or pass --allow-non-main");
    }
  }

  let message = options.message?.trim() ?? "";
  if (!message && !options.yes) {
    message = await ask("Commit message");
    if (!message) throw new Error("commit message is required");
  }

  const version = await selectVersion(options);
  if (!message) message = `Release ${version}`;

  const tag = `v${version}`;
  if (tagExists(tag)) {
    throw new Error(`tag ${tag} already exists locally or on origin`);
  }
  if (npmHasVersion(version)) {
    throw new Error(`orchivox@${version} is already published on npm`);
  }

  console.log(`\n${bold("Release summary")}`);
  console.log(`  branch   ${releaseBranch}`);
  console.log(`  version  ${readVersion()} -> ${green(version)}`);
  console.log(`  tag      ${tag}`);
  console.log(`  commit   ${message}`);
  console.log(`  checks   ${options.checks ? "typecheck, tests, secrets, pack" : "skipped"}`);
  console.log(`  publish  GitHub Release + npm`);

  console.log(`\n${bold("Working tree")}`);
  printStatus();

  if (options.dryRun) {
    console.log(`\n${yellow("dry run: no files changed, nothing pushed")}`);
    return;
  }

  if (!options.yes && !(await confirm("\nProceed with the release?", false))) {
    console.log(dim("cancelled"));
    return;
  }

  console.log(`\n${cyan("==>")} ${bold("version")}`);
  writeVersion(version);
  writeReadmeVersion(version);
  exec("bun", ["run", "build:launcher"]);

  if (options.checks) runChecks();

  console.log(`\n${cyan("==>")} ${bold("commit")}`);
  exec("git", ["add", "-A"]);
  const staged = git(["diff", "--cached", "--name-only"]).stdout.trim();
  if (!staged) throw new Error("nothing to commit");
  console.log(dim(staged.split("\n").map((line) => `  ${line}`).join("\n")));
  exec("git", ["commit", "-m", message]);

  console.log(`\n${cyan("==>")} ${bold("push")}`);
  exec("git", ["push", "-u", "origin", releaseBranch]);

  console.log(`\n${cyan("==>")} ${bold("tag")}`);
  exec("git", ["tag", "-a", tag, "-m", `Orchivox ${version}`]);
  exec("git", ["push", "origin", tag]);

  const hash = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
  console.log(`\n${green("released")} ${tag}`);
  console.log(`  commit   ${hash}`);
  console.log(`  release  ${releaseUrl(tag)}`);

  if (!options.watch) {
    console.log(`\nwatch:  gh run list --workflow=release.yml`);
    console.log(`npm:    npm view orchivox@${version} version`);
    return;
  }

  const ok = await watchRelease(tag, version, !options.yes);
  if (!ok) process.exitCode = 1;
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(
        `\n${red("release failed:")} ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    })
    .finally(() => {
      readline?.close();
    });
}

export {
  bumpVersion,
  compareSemver,
  formatSemver,
  parseArgs,
  parseSemver,
};
