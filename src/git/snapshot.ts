import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import { checkCancelled, LinebeamError } from '../core/errors';
import { contentId, createHunks } from '../core/hunks';
import { resolveRepositoryPath, samePath, validateRepositoryPath } from '../core/paths';
import {
  LIMITS,
  freezeSnapshot,
  type ChangeScope,
  type ReviewHunk,
  type ReviewSnapshot,
  type SnapshotContent,
  type SnapshotFile,
  type WorktreeStamp,
} from '../core/types';
import { gitText, parseNulList, parseRawChanges, type GitChange } from './raw';
import { runGit } from './process';

interface Manifest {
  readonly changes: readonly GitChange[];
  readonly fingerprint: string;
  readonly baseLabel: string;
}

interface Inspection {
  readonly absolute: string;
  readonly kind: 'file' | 'symlink' | 'other' | 'missing';
  readonly stamp: string;
  readonly stat?: Stats;
}

interface CapturedFile {
  readonly file: SnapshotFile;
  readonly stamp?: WorktreeStamp;
  readonly retainedBytes: number;
}

const EMPTY: SnapshotContent = Object.freeze({ id: contentId(''), text: '', bytes: 0 });
const REGULAR_MODES = new Set(['000000', '100644', '100755']);

function race(): never {
  throw new LinebeamError('The repository changed during capture. Wait for edits to finish, then Explain Changes again.', 'snapshot-race');
}

function statValue(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function readIdentity(stat: Stats): string {
  // Windows scanners can change metadata ctime when a file is opened without changing its bytes.
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function discoverRepository(workspaceRoot: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(workspaceRoot, ['rev-parse', '--show-toplevel'], {
    ...(signal ? { signal } : {}),
    allowExitCodes: [128],
  });
  if (result.code !== 0) {
    throw new LinebeamError('Open the root of a local Git repository to explain changes. The offline demo works without Git history.', 'not-repository');
  }
  const root = await fs.realpath(gitText(result.stdout).trim());
  const workspace = await fs.realpath(workspaceRoot);
  if (!samePath(root, workspace)) {
    throw new LinebeamError('Open the repository root as the workspace folder. Linebeam will not capture files outside the folder you opened.', 'repository-boundary');
  }
  return root;
}

async function readManifest(root: string, scope: ChangeScope, signal?: AbortSignal): Promise<Manifest> {
  const options = signal ? { signal } : {};
  const headResult = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { ...options, allowExitCodes: [1] });
  const head = headResult.code === 0 ? gitText(headResult.stdout).trim() : undefined;
  if (head && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) {
    throw new LinebeamError('Git returned an invalid HEAD identifier.', 'git-format');
  }
  let base = head;
  if (!base && scope === 'all') {
    base = gitText((await runGit(root, ['hash-object', '-t', 'tree', '--stdin'], options)).stdout).trim();
  }
  const args = [
    'diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv',
    '--no-relative', '--find-renames=50%', '-l200', '--ignore-submodules=none',
    ...(scope === 'staged' ? ['--cached', ...(head ? [head] : [])] : scope === 'all' && base ? [base] : []),
    '--',
  ];
  const [diff, untracked] = await Promise.all([
    runGit(root, args, options),
    scope === 'staged'
      ? Promise.resolve(undefined)
      : runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], options),
  ]);
  const changes = new Map(parseRawChanges(gitText(diff.stdout)).map((change) => [change.path, change]));
  for (const untrackedPath of parseNulList(untracked ? gitText(untracked.stdout) : '')) {
    validateRepositoryPath(untrackedPath);
    const tracked = changes.get(untrackedPath);
    if (tracked) {
      if (scope !== 'all' || tracked.kind !== 'deleted') {
        throw new LinebeamError('Git returned an ambiguous tracked/untracked path.', 'git-format');
      }
      changes.set(untrackedPath, {
        ...tracked,
        kind: 'modified',
        newMode: '100644',
        newOid: undefined,
        metadata: ['Removed from the index; saved content still exists as an untracked file.'],
      });
    } else {
      changes.set(untrackedPath, {
        path: untrackedPath,
        oldPath: untrackedPath,
        kind: 'added',
        oldMode: '000000',
        newMode: '100644',
        oldOid: undefined,
        newOid: undefined,
        metadata: [],
      });
    }
  }
  if (changes.size > LIMITS.files) {
    throw new LinebeamError(`This scope has ${changes.size} files; the limit is ${LIMITS.files}. Stage a smaller change set and choose Staged only. Nothing was sent to a model.`, 'file-limit');
  }
  const sorted = [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    changes: sorted,
    fingerprint: contentId(JSON.stringify({ scope, head: scope === 'unstaged' ? null : head, changes: sorted })),
    baseLabel: scope === 'unstaged' ? 'Git index' : head ? `HEAD ${head.slice(0, 8)}` : 'Empty tree (no commits yet)',
  };
}

async function inspectPath(root: string, relativePath: string): Promise<Inspection> {
  const absolute = resolveRepositoryPath(root, relativePath);
  const segments = relativePath.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) {
      throw new LinebeamError('An empty path component was rejected.', 'unsafe-path');
    }
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
        return { absolute, kind: 'missing', stamp: 'missing' };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return { absolute, kind: 'symlink', stamp: `symlink:${index}:${statValue(stat)}`, stat };
    }
    if (index === segments.length - 1) {
      return { absolute, kind: stat.isFile() ? 'file' : 'other', stamp: statValue(stat), stat };
    }
    if (!stat.isDirectory()) {
      return { absolute, kind: 'other', stamp: `parent:${statValue(stat)}`, stat };
    }
  }
  throw new LinebeamError('Cannot inspect an empty repository path.', 'unsafe-path');
}

async function readWorkingBytes(root: string, relativePath: string, signal?: AbortSignal): Promise<Buffer> {
  checkCancelled(signal);
  const inspection = await inspectPath(root, relativePath);
  if (inspection.kind !== 'file' || !inspection.stat || inspection.stat.size > LIMITS.fileBytes) {
    race();
  }
  const canonicalRoot = await fs.realpath(root);
  if (!samePath(await fs.realpath(inspection.absolute), resolveRepositoryPath(canonicalRoot, relativePath))) {
    race();
  }
  const handle = await fs.open(inspection.absolute, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || readIdentity(opened) !== readIdentity(inspection.stat)) {
      race();
    }
    const buffer = Buffer.alloc(Math.min(LIMITS.fileBytes + 1, opened.size + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      checkCancelled(signal);
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) {
        break;
      }
      bytesRead += read.bytesRead;
    }
    if (bytesRead !== opened.size || readIdentity(await handle.stat()) !== readIdentity(opened)) {
      race();
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function blobSize(root: string, oid: string | undefined, signal?: AbortSignal): Promise<number> {
  if (!oid) {
    return 0;
  }
  const result = await runGit(root, ['cat-file', '-s', oid], signal ? { signal } : {});
  const size = Number(gitText(result.stdout).trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new LinebeamError('Git returned an invalid object size.', 'git-format');
  }
  return size;
}

async function readBlob(root: string, oid: string | undefined, signal?: AbortSignal): Promise<Buffer> {
  if (!oid) {
    return Buffer.alloc(0);
  }
  return (await runGit(root, ['cat-file', 'blob', oid], {
    ...(signal ? { signal } : {}),
    maxBytes: LIMITS.fileBytes,
  })).stdout;
}

function decodeContent(buffer: Buffer): { content: SnapshotContent; reason?: string } {
  const base = { id: contentId(buffer), bytes: buffer.length };
  if (buffer.includes(0)) {
    return { content: base, reason: 'Binary or UTF-16 content is not analyzed. Only UTF-8 text is supported.' };
  }
  try {
    return { content: { ...base, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) } };
  } catch {
    return { content: base, reason: 'Non-UTF-8 content is not analyzed.' };
  }
}

export class GitSnapshotService {
  constructor(
    readonly root: string,
    private readonly excludeGlobs: readonly string[] = [],
  ) {
    if (excludeGlobs.length > 100 || excludeGlobs.some((pattern) => typeof pattern !== 'string' || pattern.length > 1_000)) {
      throw new LinebeamError('Use at most 100 exclusion patterns, each at most 1000 characters.', 'invalid-configuration');
    }
  }

  async capture(scope: ChangeScope, signal?: AbortSignal, report: (message: string) => void = () => {}): Promise<ReviewSnapshot> {
    checkCancelled(signal);
    const manifest = await readManifest(this.root, scope, signal);
    const id = `s-${randomUUID()}`;
    const files: SnapshotFile[] = [];
    const stamps: WorktreeStamp[] = [];
    let bytes = 0;
    let hunkCount = 0;
    for (const [index, change] of manifest.changes.entries()) {
      checkCancelled(signal);
      report(`Capturing ${index + 1}/${manifest.changes.length}: ${change.path}`);
      const captured = await this.captureFile(id, `f-${index + 1}`, change, scope, bytes, hunkCount, signal);
      files.push(captured.file);
      bytes += captured.retainedBytes;
      hunkCount += captured.file.hunks.length;
      if (captured.stamp) {
        stamps.push(captured.stamp);
      }
    }
    const snapshot = freezeSnapshot({
      id,
      repositoryRoot: this.root,
      repositoryName: path.basename(this.root),
      scope,
      capturedAt: new Date().toISOString(),
      baseLabel: manifest.baseLabel,
      files,
      manifestFingerprint: manifest.fingerprint,
      worktreeStamps: stamps,
      isDemo: false,
    });
    if (await this.hasChanged(snapshot, signal)) {
      race();
    }
    return snapshot;
  }

  private async captureFile(
    snapshotId: string,
    id: string,
    change: GitChange,
    scope: ChangeScope,
    usedBytes: number,
    usedHunks: number,
    signal?: AbortSignal,
  ): Promise<CapturedFile> {
    const fromDisk = scope !== 'staged' && change.newMode !== '000000';
    const inspection = fromDisk ? await inspectPath(this.root, change.path) : undefined;
    const metadata = [...change.metadata];
    if (change.kind === 'renamed') {
      metadata.push(`Renamed from ${change.oldPath}.`);
    }
    if (change.oldMode !== change.newMode && change.oldMode !== '000000' && change.newMode !== '000000') {
      metadata.push(`Git mode changed from ${change.oldMode} to ${change.newMode}.`);
    }
    const basic = { id, path: change.path, oldPath: change.oldPath, kind: change.kind, metadata };
    const statStamp: WorktreeStamp | undefined = inspection
      ? { path: change.path, value: inspection.stamp, method: 'stat' }
      : undefined;
    const unsupported = (reason: string, beforeBytes = 0, afterBytes = inspection?.stat?.size ?? 0): CapturedFile => ({
      file: {
        ...basic,
        before: { id: change.oldOid ? `git:${change.oldOid}` : 'not-captured', bytes: beforeBytes },
        after: { id: change.newOid ? `git:${change.newOid}` : 'not-captured', bytes: afterBytes },
        hunks: [],
        unsupportedReason: reason,
      },
      ...(statStamp ? { stamp: statStamp } : {}),
      retainedBytes: 0,
    });
    const excludedBy = this.excludeGlobs.find((pattern) =>
      [change.path, change.oldPath].some((candidate) => minimatch(candidate, pattern, { dot: true, nocase: process.platform === 'win32', nonegate: true, nocomment: true })),
    );
    if (excludedBy) {
      return unsupported(`Excluded by pattern "${excludedBy}". No contents were captured or sent to the model.`);
    }
    if (change.kind === 'unmerged') {
      return unsupported('Unresolved merge conflict. Resolve the conflict before explaining this file.');
    }
    if (change.oldMode === '160000' || change.newMode === '160000') {
      return unsupported('Submodule changes are not analyzed in the single-repository MVP.');
    }
    if (!REGULAR_MODES.has(change.oldMode) || !REGULAR_MODES.has(change.newMode) || inspection?.kind === 'symlink') {
      return unsupported('Symbolic links and non-regular files are not followed or analyzed.');
    }
    if (inspection && inspection.kind !== 'file') {
      if (inspection.kind === 'missing') {
        race();
      }
      return unsupported('This working-tree path is not a regular file.');
    }
    if (scope === 'staged' && change.newMode !== '000000' && !change.newOid) {
      throw new LinebeamError('The index has no immutable blob for this change.', 'git-format');
    }
    const [beforeSize, afterSize] = await Promise.all([
      blobSize(this.root, change.oldOid, signal),
      fromDisk ? Promise.resolve(inspection?.stat?.size ?? 0) : blobSize(this.root, change.newOid, signal),
    ]);
    if (beforeSize > LIMITS.fileBytes || afterSize > LIMITS.fileBytes) {
      return unsupported('File exceeds the 256 KiB per-side text limit. No contents were sent to the model.', beforeSize, afterSize);
    }
    if (usedBytes + beforeSize + afterSize > LIMITS.snapshotBytes) {
      return unsupported('The 8 MiB snapshot text budget was reached. Narrow the scope to include this file.', beforeSize, afterSize);
    }
    const [beforeBytes, afterBytes] = await Promise.all([
      readBlob(this.root, change.oldOid, signal),
      fromDisk ? readWorkingBytes(this.root, change.path, signal) : readBlob(this.root, change.newOid, signal),
    ]);
    const before = change.oldMode === '000000' ? { content: EMPTY } : decodeContent(beforeBytes);
    const after = change.newMode === '000000' ? { content: EMPTY } : decodeContent(afterBytes);
    const stamp: WorktreeStamp | undefined = fromDisk
      ? { path: change.path, value: contentId(afterBytes), method: 'content' }
      : undefined;
    const reason = before.reason ?? after.reason;
    if (reason || before.content.text === undefined || after.content.text === undefined) {
      return {
        file: {
          ...basic,
          before: { id: before.content.id, bytes: before.content.bytes },
          after: { id: after.content.id, bytes: after.content.bytes },
          hunks: [],
          unsupportedReason: reason ?? 'Unsupported text encoding.',
        },
        ...(stamp ? { stamp } : {}),
        retainedBytes: 0,
      };
    }
    let hunks: ReviewHunk[];
    let unsupportedReason: string | undefined;
    try {
      hunks = createHunks(snapshotId, id, before.content.text, after.content.text);
    } catch (error) {
      if (!(error instanceof LinebeamError) || error.code !== 'diff-limit') {
        throw error;
      }
      hunks = [];
      unsupportedReason = error.message;
    }
    if (usedHunks + hunks.length > LIMITS.hunks) {
      hunks = [];
      unsupportedReason = 'The 400-hunk snapshot limit was reached. Captured text can be inspected, but this file was not sent to the model.';
    }
    if (hunks.length === 0 && before.content.text !== after.content.text && !unsupportedReason) {
      metadata.push('Line endings changed without a line-content change.');
    }
    return {
      file: {
        ...basic,
        before: before.content,
        after: after.content,
        hunks,
        ...(unsupportedReason ? { unsupportedReason } : {}),
      },
      ...(stamp ? { stamp } : {}),
      retainedBytes: beforeBytes.length + afterBytes.length,
    };
  }

  async hasChanged(snapshot: ReviewSnapshot, signal?: AbortSignal): Promise<boolean> {
    if (!samePath(this.root, snapshot.repositoryRoot)) {
      throw new LinebeamError('A snapshot belongs to a different repository.', 'repository-boundary');
    }
    const manifest = await readManifest(this.root, snapshot.scope, signal);
    if (manifest.fingerprint !== snapshot.manifestFingerprint) {
      return true;
    }
    for (const stamp of snapshot.worktreeStamps) {
      checkCancelled(signal);
      if (stamp.method === 'stat') {
        if ((await inspectPath(this.root, stamp.path)).stamp !== stamp.value) {
          return true;
        }
      } else {
        try {
          if (contentId(await readWorkingBytes(this.root, stamp.path, signal)) !== stamp.value) {
            return true;
          }
        } catch (error) {
          if ((error instanceof LinebeamError && error.code === 'snapshot-race') || hasCode(error, 'ENOENT') || hasCode(error, 'ELOOP')) {
            return true;
          }
          throw error;
        }
      }
    }
    return false;
  }
}
