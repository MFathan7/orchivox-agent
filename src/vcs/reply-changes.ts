import { chmodSync, closeSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_BYTES = 16 * 1024 * 1024;

interface FileRevision {
  bytes: string;
  mode: number;
}

type Revision = FileRevision | null;
export type WrittenFile = string | Uint8Array | null;

export interface ReplyFileChange {
  path: string;
  before?: Revision;
  after?: Revision;
  issue?: string;
}

export interface SavedReplyChanges {
  files: ReplyFileChange[];
  reverted: boolean;
}

export class ReplyChangesConflict extends Error {
  constructor(readonly paths: string[]) {
    super("Undo stopped. Files changed since this reply.");
  }
}

type Draft = ReplyFileChange & { pending?: true; observed: boolean };

function filePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const name = relative(root, absolute);
  if (!name || isAbsolute(name) || name === ".." || name.startsWith(`..${sep}`)
    || name.split(sep).some((part) => part.toLowerCase() === ".git")
    || (process.platform === "win32" && name.includes(":"))) {
    throw new Error("The path is outside the editable workspace.");
  }
  return absolute;
}

function readRevision(root: string, path: string): Revision {
  const absolute = filePath(root, path);
  for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A parent path is not a regular directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let info;
  try {
    info = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1) throw new Error("Only regular files without links can be restored.");
  if (info.mode & 0o7000) throw new Error("The file has special permissions.");
  if (info.size > MAX_FILE_BYTES) throw new Error("The file exceeds the 2 MiB review limit.");
  const bytes = readFileSync(absolute);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("The file exceeds the 2 MiB review limit.");
  return { bytes: bytes.toString("base64"), mode: info.mode & 0o777 };
}

function sameRevision(left: Revision | undefined, right: Revision | undefined): boolean {
  return left === right || Boolean(left && right && left.mode === right.mode && left.bytes === right.bytes);
}

function matchesWrite(revision: Revision, written: WrittenFile): boolean {
  if (written === null) return revision === null;
  const bytes = typeof written === "string" ? Buffer.from(written) : Buffer.from(written.buffer, written.byteOffset, written.byteLength);
  return revision !== null && bytes.toString("base64") === revision.bytes;
}

export class ReplyChanges {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly drafts = new Map<string, Draft>();

  constructor(root: string) {
    this.root = resolve(root);
    this.realRoot = realpathSync(root);
  }

  beforeWrite(path: string): void {
    const name = relative(this.root, resolve(this.root, path));
    let draft = this.drafts.get(name);
    try {
      const revision = readRevision(this.realRoot, name);
      if (draft?.observed && !sameRevision(draft.after, revision)) {
        draft.issue ??= "The file changed between recorded edits.";
      }
      if (!draft) draft = { path: name, before: revision, observed: false };
    } catch (error) {
      draft ??= { path: name || path, observed: false };
      draft.issue ??= (error as Error).message;
    }
    draft.pending = true;
    this.drafts.set(name, draft);
  }

  afterWrite(path: string, written: WrittenFile): void {
    const name = relative(this.root, resolve(this.root, path));
    const draft = this.drafts.get(name);
    if (!draft) return;
    draft.observed = true;
    delete draft.pending;
    try {
      const revision = readRevision(this.realRoot, name);
      if (!matchesWrite(revision, written)) {
        draft.issue ??= "The file did not match the recorded write.";
        return;
      }
      draft.after = revision;
    } catch (error) {
      draft.issue ??= (error as Error).message;
    }
  }

  finish(): ReplyFileChange[] {
    const files: ReplyFileChange[] = [];
    let bytes = 0;
    for (const { path, before, after, issue, observed, pending } of this.drafts.values()) {
      let problem = issue;
      if (pending) {
        try {
          if (!sameRevision(readRevision(this.realRoot, path), observed ? after : before)) {
            problem ??= "A write ended before its result could be verified.";
          }
        } catch (error) {
          problem ??= (error as Error).message;
        }
      }
      if (!problem && (!observed || sameRevision(before, after))) continue;
      bytes += (before?.bytes.length ?? 0) + (after?.bytes.length ?? 0);
      files.push({ path, before, after, issue: problem });
    }
    if (bytes > MAX_REPLY_BYTES) return files.map(({ path, issue }) => ({ path, issue: issue ?? "The reply exceeds the review storage limit." }));
    return files;
  }
}

export function replyFileDiff(file: ReplyFileChange): { before: string; after: string } | undefined {
  if (file.before === undefined || file.after === undefined) return undefined;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const before = decoder.decode(Buffer.from(file.before?.bytes ?? "", "base64"));
    const after = decoder.decode(Buffer.from(file.after?.bytes ?? "", "base64"));
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(before + after)) return undefined;
    return { before, after };
  } catch {
    return undefined;
  }
}

function restoreFile(root: string, path: string, from: Revision, to: Revision, applied?: () => void): void {
  const absolute = filePath(root, path);
  const check = () => {
    if (!sameRevision(readRevision(root, path), from)) throw new Error(`File changed: ${path}`);
  };
  if (!to) {
    check();
    unlinkSync(absolute);
    applied?.();
    return;
  }
  const staged = join(dirname(absolute), `.orchivox-${crypto.randomUUID()}.tmp`);
  check();
  const fd = openSync(staged, "wx", to.mode);
  try {
    try { writeFileSync(fd, Buffer.from(to.bytes, "base64")); }
    finally { closeSync(fd); }
    chmodSync(staged, to.mode);
    check();
    if (from === null) linkSync(staged, absolute);
    else renameSync(staged, absolute);
    applied?.();
  } finally {
    try { unlinkSync(staged); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function revertReplyChanges(workspaceRoot: string, files: readonly ReplyFileChange[], markReverted: () => void): void {
  const root = realpathSync(workspaceRoot);
  const restore = files.map(({ path, issue, before, after }) => {
    if (issue || before === undefined || after === undefined) throw new Error(`Undo unavailable for ${path}. ${issue ?? "A file revision is missing."}`);
    return { path, before, after };
  });
  const conflicts = restore.filter(({ path, after }) => {
    try { return !sameRevision(readRevision(root, path), after); }
    catch { return true; }
  });
  if (conflicts.length) throw new ReplyChangesConflict(conflicts.map(({ path }) => path));

  const applied: typeof restore = [];
  try {
    for (const file of restore) {
      restoreFile(root, file.path, file.after, file.before, () => applied.push(file));
    }
    markReverted();
  } catch (error) {
    const recoveryFailed: string[] = [];
    for (const file of applied.reverse()) {
      try { restoreFile(root, file.path, file.before, file.after); }
      catch { recoveryFailed.push(file.path); }
    }
    if (recoveryFailed.length) throw new Error(`Undo stopped and recovery could not restore: ${recoveryFailed.join(", ")}`);
    throw error;
  }
}
