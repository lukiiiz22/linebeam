import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitSnapshotService, discoverRepository } from '../src/git/snapshot';
import { runGit } from '../src/git/process';
import { LIMITS } from '../src/core/types';

async function repository(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linebeam-unit-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await runGit(root, ['init', '--quiet', '--initial-branch=main']);
  await runGit(root, ['config', 'user.name', 'Linebeam Test']);
  await runGit(root, ['config', 'user.email', 'linebeam@example.invalid']);
  await runGit(root, ['config', 'commit.gpgsign', 'false']);
  await runGit(root, ['config', 'core.autocrlf', 'false']);
  await runGit(root, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
  return root;
}

async function write(root: string, relativePath: string, content: string | Buffer): Promise<void> {
  const absolute = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

async function commit(root: string): Promise<void> {
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '--quiet', '-m', 'fixture']);
}

test('all, staged and unstaged use distinct immutable baselines', async (t) => {
  const root = await repository(t);
  await write(root, 'src/file.ts', 'base\n');
  await write(root, '.gitignore', 'ignored.txt\n');
  await commit(root);
  await write(root, 'src/file.ts', 'staged\n');
  await runGit(root, ['add', '--', 'src/file.ts']);
  await write(root, 'src/file.ts', 'working\n');
  await write(root, 'new.ts', 'untracked\n');
  await write(root, 'ignored.txt', 'ignored\n');
  const service = new GitSnapshotService(root);
  const staged = await service.capture('staged');
  const unstaged = await service.capture('unstaged');
  const all = await service.capture('all');
  const find = (snapshot: typeof all) => snapshot.files.find((file) => file.path === 'src/file.ts');
  assert.equal(find(staged)?.before.text, 'base\n');
  assert.equal(find(staged)?.after.text, 'staged\n');
  assert.equal(find(unstaged)?.before.text, 'staged\n');
  assert.equal(find(unstaged)?.after.text, 'working\n');
  assert.equal(find(all)?.before.text, 'base\n');
  assert.equal(find(all)?.after.text, 'working\n');
  assert.equal(staged.files.length, 1);
  assert.equal(unstaged.files.length, 2);
  assert.equal(all.files.length, 2);
  assert.equal(await service.hasChanged(all), false);
  await write(root, 'src/file.ts', 'changed again\n');
  assert.equal(await service.hasChanged(all), true);
  assert.equal(await service.hasChanged(staged), false);
  assert.equal(find(all)?.after.text, 'working\n');
});

test('repositories without an initial commit use an empty baseline', async (t) => {
  const root = await repository(t);
  await write(root, 'first.ts', 'staged\n');
  await runGit(root, ['add', '--', 'first.ts']);
  await write(root, 'first.ts', 'working\n');
  await write(root, 'second.ts', 'untracked\n');
  const service = new GitSnapshotService(root);
  const all = await service.capture('all');
  const staged = await service.capture('staged');
  const unstaged = await service.capture('unstaged');
  assert.equal(all.files.length, 2);
  assert.equal(all.files[0]?.before.text, '');
  assert.equal(all.files[0]?.after.text, 'working\n');
  assert.match(all.baseLabel, /no commits/);
  assert.equal(staged.files[0]?.after.text, 'staged\n');
  assert.equal(unstaged.files[0]?.before.text, 'staged\n');
});

test('deleted contents remain available on the old side', async (t) => {
  const root = await repository(t);
  await write(root, 'deleted.ts', 'old code\n');
  await commit(root);
  await fs.unlink(path.join(root, 'deleted.ts'));
  const snapshot = await new GitSnapshotService(root).capture('all');
  assert.equal(snapshot.files[0]?.kind, 'deleted');
  assert.equal(snapshot.files[0]?.before.text, 'old code\n');
  assert.equal(snapshot.files[0]?.after.text, '');
  assert.deepEqual(snapshot.files[0]?.hunks[0]?.newRanges, []);
});

test('staged renames preserve both paths and metadata even without textual changes', async (t) => {
  const root = await repository(t);
  await write(root, 'old name.ts', 'unchanged\n');
  await commit(root);
  await fs.rename(path.join(root, 'old name.ts'), path.join(root, 'new name.ts'));
  await runGit(root, ['add', '--all']);
  const snapshot = await new GitSnapshotService(root).capture('staged');
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0]?.kind, 'renamed');
  assert.equal(snapshot.files[0]?.oldPath, 'old name.ts');
  assert.equal(snapshot.files[0]?.path, 'new name.ts');
  assert.equal(snapshot.files[0]?.before.text, snapshot.files[0]?.after.text);
  assert.equal(snapshot.files[0]?.hunks.length, 0);
  assert.match(snapshot.files[0]?.metadata.join(' ') ?? '', /Renamed/);
});

test('filenames with spaces, Unicode and leading option characters are data', async (t) => {
  const root = await repository(t);
  await write(root, '-option name-\u4e2d.ts', 'before\n');
  await commit(root);
  await write(root, '-option name-\u4e2d.ts', 'after\n');
  const snapshot = await new GitSnapshotService(root).capture('all');
  assert.equal(snapshot.files[0]?.path, '-option name-\u4e2d.ts');
  assert.equal(snapshot.files[0]?.after.text, 'after\n');
});

test('binary, oversized, excluded and non-UTF-8 files are retained as explicit omissions', async (t) => {
  const root = await repository(t);
  await write(root, 'binary.bin', Buffer.from([0, 1, 2]));
  await write(root, 'legacy.txt', Buffer.from([0xff, 0xfe, 0x61]));
  await write(root, 'large.txt', Buffer.alloc(LIMITS.fileBytes + 1, 65));
  await write(root, '.env', 'FAKE_TOKEN=fixture-not-a-secret');
  const snapshot = await new GitSnapshotService(root, ['**/.env']).capture('all');
  assert.equal(snapshot.files.length, 4);
  assert.ok(snapshot.files.every((file) => file.unsupportedReason));
  assert.ok(snapshot.files.every((file) => file.after.text === undefined));
  assert.match(snapshot.files.find((file) => file.path === '.env')?.unsupportedReason ?? '', /Excluded/);
  assert.match(snapshot.files.find((file) => file.path === 'large.txt')?.unsupportedReason ?? '', /256 KiB/);
});

test('renaming an excluded file cannot bypass its original-path exclusion', async (t) => {
  const root = await repository(t);
  await write(root, '.env', 'FAKE_TOKEN=fixture-not-a-secret\n');
  await commit(root);
  await fs.rename(path.join(root, '.env'), path.join(root, 'public.txt'));
  await runGit(root, ['add', '--all']);
  const snapshot = await new GitSnapshotService(root, ['**/.env']).capture('staged');
  assert.equal(snapshot.files[0]?.kind, 'renamed');
  assert.match(snapshot.files[0]?.unsupportedReason ?? '', /Excluded/);
  assert.equal(snapshot.files[0]?.before.text, undefined);
});

test('symlink blobs are not treated as files or followed', async (t) => {
  const root = await repository(t);
  const oid = (await runGit(root, ['hash-object', '-w', '--stdin'], { input: '../outside.txt' })).stdout.toString().trim();
  await runGit(root, ['update-index', '--add', '--cacheinfo', `120000,${oid},link`]);
  const snapshot = await new GitSnapshotService(root).capture('staged');
  assert.match(snapshot.files[0]?.unsupportedReason ?? '', /Symbolic links/);
  assert.equal(snapshot.files[0]?.after.text, undefined);
});

test('working-tree directory symlinks are not traversed', async (t) => {
  const root = await repository(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'linebeam-link-target-'));
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(outside, 'private.txt'), 'not part of the repository');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await new GitSnapshotService(root).capture('all');
  assert.equal(snapshot.files.length, 1);
  assert.match(snapshot.files[0]?.unsupportedReason ?? '', /Symbolic links/);
});

test('mode-only changes and empty files remain visible without fake hunks', async (t) => {
  const root = await repository(t);
  await write(root, 'run.sh', 'echo hello\n');
  await commit(root);
  await runGit(root, ['update-index', '--chmod=+x', 'run.sh']);
  await write(root, 'empty.txt', '');
  await runGit(root, ['add', '--', 'empty.txt']);
  const snapshot = await new GitSnapshotService(root).capture('staged');
  assert.equal(snapshot.files.length, 2);
  assert.ok(snapshot.files.every((file) => file.hunks.length === 0));
  assert.match(snapshot.files.find((file) => file.path === 'run.sh')?.metadata.join(' ') ?? '', /mode changed/);
});

test('removing a file from the index while retaining its saved content is accounted for', async (t) => {
  const root = await repository(t);
  await write(root, 'kept.txt', 'content\n');
  await commit(root);
  await runGit(root, ['rm', '--cached', '--', 'kept.txt']);
  const service = new GitSnapshotService(root);
  const all = await service.capture('all');
  assert.equal(all.files.length, 1);
  assert.equal(all.files[0]?.before.text, 'content\n');
  assert.equal(all.files[0]?.after.text, 'content\n');
  assert.match(all.files[0]?.metadata.join(' ') ?? '', /untracked/);
  assert.equal((await service.capture('staged')).files[0]?.kind, 'deleted');
  assert.equal((await service.capture('unstaged')).files[0]?.kind, 'added');
});

test('unmerged index entries are visible but not explained as resolved code', async (t) => {
  const root = await repository(t);
  await write(root, 'conflict.txt', 'base\n');
  await commit(root);
  const base = (await runGit(root, ['rev-parse', 'HEAD:conflict.txt'])).stdout.toString().trim();
  const other = (await runGit(root, ['hash-object', '-w', '--stdin'], { input: 'other\n' })).stdout.toString().trim();
  await runGit(root, ['update-index', '--index-info'], {
    input: `0 ${'0'.repeat(40)}\tconflict.txt\n100644 ${base} 1\tconflict.txt\n100644 ${base} 2\tconflict.txt\n100644 ${other} 3\tconflict.txt\n`,
  });
  const snapshot = await new GitSnapshotService(root).capture('unstaged');
  assert.equal(snapshot.files.length, 1);
  assert.match(snapshot.files[0]?.unsupportedReason ?? '', /merge conflict/);
});

test('freshness catches changed contents, new files, staging and HEAD changes', async (t) => {
  const root = await repository(t);
  await write(root, 'file.txt', 'base\n');
  await commit(root);
  await write(root, 'file.txt', 'edit\n');
  const service = new GitSnapshotService(root);
  const snapshot = await service.capture('all');
  const stat = await fs.stat(path.join(root, 'file.txt'));
  await write(root, 'file.txt', 'swap\n');
  await fs.utimes(path.join(root, 'file.txt'), stat.atime, stat.mtime);
  assert.equal(await service.hasChanged(snapshot), true);
  const next = await service.capture('all');
  await write(root, 'new.txt', 'new\n');
  assert.equal(await service.hasChanged(next), true);
  await runGit(root, ['add', '--all']);
  const staged = await service.capture('staged');
  await write(root, 'file.txt', 'new index\n');
  await runGit(root, ['add', '--all']);
  assert.equal(await service.hasChanged(staged), true);
  const beforeCommit = await service.capture('staged');
  await commit(root);
  assert.equal(await service.hasChanged(beforeCommit), true);
});

test('capturing and checking freshness do not mutate Git state or saved files', async (t) => {
  const root = await repository(t);
  await write(root, 'file.txt', 'base\n');
  await commit(root);
  await write(root, 'file.txt', 'edit\n');
  const before = (await runGit(root, ['status', '--porcelain=v1', '-z'])).stdout;
  const indexBefore = await fs.readFile(path.join(root, '.git', 'index'));
  const service = new GitSnapshotService(root);
  const snapshot = await service.capture('all');
  assert.equal(await service.hasChanged(snapshot), false);
  assert.deepEqual((await runGit(root, ['status', '--porcelain=v1', '-z'])).stdout, before);
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), indexBefore);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'edit\n');
});

test('the file-count limit rejects rather than silently truncating the scope', async (t) => {
  const root = await repository(t);
  await Promise.all(Array.from({ length: LIMITS.files + 1 }, (_, index) => write(root, `f-${index}.txt`, 'x')));
  await assert.rejects(new GitSnapshotService(root).capture('all'), /201 files/);
});

test('the per-side limit accepts exactly 256 KiB and the combined snapshot budget stops at 8 MiB', async (t) => {
  const root = await repository(t);
  const before = `${'a'.repeat(LIMITS.fileBytes - 1)}\n`;
  const after = `b${before.slice(1)}`;
  const names = Array.from({ length: 17 }, (_, index) => `file-${String(index).padStart(2, '0')}.txt`);
  await Promise.all(names.map((name) => write(root, name, before)));
  await commit(root);
  await Promise.all(names.map((name) => write(root, name, after)));
  const snapshot = await new GitSnapshotService(root).capture('all');
  const captured = snapshot.files.filter((file) => !file.unsupportedReason);
  assert.equal(captured.length, 16);
  assert.ok(captured.every((file) => file.before.bytes === LIMITS.fileBytes && file.after.bytes === LIMITS.fileBytes));
  assert.equal(captured.reduce((bytes, file) => bytes + file.before.bytes + file.after.bytes, 0), LIMITS.snapshotBytes);
  assert.equal(snapshot.files.length, 17);
  assert.match(snapshot.files[16]?.unsupportedReason ?? '', /8 MiB/);
});

test('400 hunks are accepted and a 401-hunk file is visibly omitted rather than truncated', async (t) => {
  const root = await repository(t);
  const blocks = (changed: number): string => Array.from({ length: 401 }, (_, index) =>
    `${index < changed ? 'new' : 'old'} ${index}\n${Array.from({ length: 8 }, (_, line) => `context ${index} ${line}\n`).join('')}`,
  ).join('');
  await write(root, 'many.txt', blocks(0));
  await commit(root);
  const service = new GitSnapshotService(root);
  await write(root, 'many.txt', blocks(400));
  const supported = await service.capture('all');
  assert.equal(supported.files[0]?.hunks.length, 400);
  await write(root, 'many.txt', blocks(401));
  const omitted = await service.capture('all');
  assert.equal(omitted.files[0]?.hunks.length, 0);
  assert.match(omitted.files[0]?.unsupportedReason ?? '', /400-hunk/);
  assert.equal(omitted.files[0]?.after.text, blocks(401), 'Manual inspection still has the captured text');
});

test('discovery requires the actual open repository root', async (t) => {
  const root = await repository(t);
  assert.equal(await discoverRepository(root), await fs.realpath(root));
  await fs.mkdir(path.join(root, 'nested'));
  await assert.rejects(discoverRepository(path.join(root, 'nested')), /repository root/);
});

test('cancellation stops before Git capture or process launch', async (t) => {
  const root = await repository(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new GitSnapshotService(root).capture('all', controller.signal), /cancelled/);
  await assert.rejects(runGit(root, ['status'], { signal: controller.signal }), /cancelled/);
});
