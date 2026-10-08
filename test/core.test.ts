import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHunks } from '../src/core/hunks';
import { validateRepositoryPath, resolveRepositoryPath } from '../src/core/paths';
import { createCoverage, validatePlanResponse } from '../src/core/plan';
import { createDemo } from '../src/fixtures/demo';
import { parseRawChanges } from '../src/git/raw';
import { LIMITS, type ReviewSnapshot } from '../src/core/types';
import * as path from 'node:path';

function response(snapshot: ReviewSnapshot): {
  snapshotId: string;
  steps: { title: string; explanation: string; significance: string; references: { hunkId: string; side: string }[] }[];
  skipped: { hunkId: string; reason: string }[];
} {
  const hunk = snapshot.files[0]?.hunks[0];
  assert.ok(hunk);
  return {
    snapshotId: snapshot.id,
    steps: [{
      title: 'Check the response',
      explanation: 'The response status is checked.',
      significance: 'Failures become explicit.',
      references: [{ hunkId: hunk.id, side: 'new' }],
    }],
    skipped: [],
  };
}

function sent(snapshot: ReviewSnapshot): Set<string> {
  return new Set(snapshot.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
}

test('hunks resolve only changed lines, not context', () => {
  const [hunk] = createHunks('s', 'f', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.deepEqual(hunk?.oldRanges, [{ start: 2, end: 2 }]);
  assert.deepEqual(hunk?.newRanges, [{ start: 2, end: 2 }]);
});

test('addition and deletion references have only their populated side', () => {
  const [added] = createHunks('s', 'a', '', 'hello\nworld\n');
  assert.deepEqual(added?.oldRanges, []);
  assert.deepEqual(added?.newRanges, [{ start: 1, end: 2 }]);
  const [deleted] = createHunks('s', 'd', 'hello\n', '');
  assert.deepEqual(deleted?.oldRanges, [{ start: 1, end: 1 }]);
  assert.deepEqual(deleted?.newRanges, []);
});

test('CRLF and lone CR preserve editor line numbers without whole-file noise', () => {
  for (const eol of ['\r\n', '\r']) {
    const [hunk] = createHunks('s', 'f', 'one\ntwo\n', `one${eol}TWO${eol}`);
    assert.deepEqual(hunk?.newRanges, [{ start: 2, end: 2 }]);
  }
});

test('hunk ids are bound to a snapshot', () => {
  assert.notEqual(createHunks('s1', 'f', '', 'a')[0]?.id, createHunks('s2', 'f', '', 'a')[0]?.id);
});

test('repository paths reject traversal, absolute paths, ADS and Git metadata', () => {
  for (const value of ['', '../secret', 'src/../secret', '/etc/passwd', 'C:/secret', 'src\\file', 'a:b', 'a//b', '.git/config', 'a/.GIT/config', 'a\0b']) {
    assert.throws(() => validateRepositoryPath(value), /path/i, value);
  }
  assert.equal(validateRepositoryPath('src/a file-\u4e2d.ts'), 'src/a file-\u4e2d.ts');
  assert.equal(resolveRepositoryPath(path.resolve('root'), 'src/file.ts'), path.resolve('root', 'src', 'file.ts'));
});

test('NUL raw parsing handles spaces, tabs, newlines and renames', () => {
  const old = 'a'.repeat(40);
  const next = 'b'.repeat(40);
  const [change] = parseRawChanges(`:100644 100644 ${old} ${next} R100\0old name.ts\0new\tname\n.ts\0`);
  assert.equal(change?.kind, 'renamed');
  assert.equal(change?.oldPath, 'old name.ts');
  assert.equal(change?.path, 'new\tname\n.ts');
  assert.equal(change?.oldOid, old);
});

test('raw parser rejects truncated output and prefers an unmerged record', () => {
  const zero = '0'.repeat(40);
  assert.throws(() => parseRawChanges(`:100644 100644 ${zero} ${zero} M\0file`), /incomplete/);
  assert.throws(() => parseRawChanges(`:100644 100644 ${zero} ${zero} M\0../secret\0`), /path/);
  const records = parseRawChanges(`:000000 100644 ${zero} ${zero} U\0file\0:100644 100644 ${zero} ${zero} M\0file\0`);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, 'unmerged');
});

test('the offline demo is fully validated, immutable, and accounts for metadata and binary content', () => {
  const demo = createDemo();
  assert.equal(demo.plan.steps.length, 4);
  assert.equal(demo.plan.coverage.filter((item) => item.status === 'explained').length, 4);
  assert.equal(demo.plan.coverage.filter((item) => item.status === 'unsupported').length, 1);
  assert.ok(demo.plan.coverage.some((item) => item.reason.includes('Renamed')));
  assert.ok(Object.isFrozen(demo.snapshot.files[0]?.hunks[0]?.newRanges));
  assert.ok(Object.isFrozen(demo.plan.steps[0]));
});

test('missing model coverage is explicit rather than silently treated as explained', () => {
  const { snapshot } = createDemo();
  const plan = validatePlanResponse(JSON.stringify(response(snapshot)), snapshot, sent(snapshot));
  assert.equal(plan.coverage.filter((entry) => entry.status === 'explained').length, 1);
  assert.equal(plan.coverage.filter((entry) => entry.status === 'unexplained' && entry.hunkId).length, 3);
});

test('intentional skips and budget omissions retain different reasons', () => {
  const { snapshot } = createDemo();
  const parsed = response(snapshot);
  const ids = [...sent(snapshot)];
  assert.ok(ids[1] && ids[2]);
  parsed.skipped.push({ hunkId: ids[1], reason: 'Small support type.' });
  const plan = validatePlanResponse(JSON.stringify(parsed), snapshot, sent(snapshot), new Map([[ids[2], 'Not sent: budget.']]));
  assert.ok(plan.coverage.some((entry) => entry.status === 'skipped' && entry.reason === 'Small support type.'));
  assert.ok(plan.coverage.some((entry) => entry.status === 'unexplained' && entry.reason === 'Not sent: budget.'));
});

test('the validator accepts a single JSON fence but rejects prose and malformed output', () => {
  const { snapshot } = createDemo();
  const json = JSON.stringify(response(snapshot));
  assert.equal(validatePlanResponse(`\`\`\`json\n${json}\n\`\`\``, snapshot, sent(snapshot)).steps.length, 1);
  for (const invalid of ['Here is your plan: ' + json, '{', '', '[]', 'null', ' '.repeat(LIMITS.responseCharacters + 1)]) {
    assert.throws(() => validatePlanResponse(invalid, snapshot, sent(snapshot)), /invalid walkthrough/);
  }
});

test('snapshot mismatches and fabricated or unsubmitted hunk ids are rejected', () => {
  const { snapshot } = createDemo();
  const parsed = response(snapshot);
  assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, snapshotId: 'different' }), snapshot, sent(snapshot)), /snapshot identifier/);
  assert.throws(() => validatePlanResponse(JSON.stringify(parsed), snapshot, new Set()), /submitted/);
  const step = parsed.steps[0];
  assert.ok(step);
  step.references = [{ hunkId: 'invented', side: 'new' }];
  assert.throws(() => validatePlanResponse(JSON.stringify(parsed), snapshot, sent(snapshot)), /submitted/);
});

test('deletions cannot point at a nonexistent new-side change', () => {
  const { snapshot } = createDemo();
  const parsed = response(snapshot);
  const deletion = snapshot.files.find((file) => file.kind === 'deleted')?.hunks[0];
  const step = parsed.steps[0];
  assert.ok(step && deletion);
  step.references = [{ hunkId: deletion.id, side: 'new' }];
  assert.throws(() => validatePlanResponse(JSON.stringify(parsed), snapshot, sent(snapshot)), /no changed lines/);
});

test('range validation rejects out-of-bounds or non-integer snapshot ranges', () => {
  const { snapshot } = createDemo();
  const file = snapshot.files[0];
  const hunk = file?.hunks[0];
  assert.ok(file && hunk);
  for (const range of [{ start: 0, end: 1 }, { start: 1, end: 99_999 }, { start: 1.5, end: 2 }, { start: 4, end: 2 }]) {
    const invalidSnapshot = {
      ...snapshot,
      files: [{ ...file, hunks: [{ ...hunk, newRanges: [range] }] }, ...snapshot.files.slice(1)],
    };
    assert.throws(() => validatePlanResponse(JSON.stringify(response(snapshot)), invalidSnapshot, sent(snapshot)), /outside the immutable document/);
  }
});

test('unexpected fields, invalid sides, duplicates and contradictory skips are rejected', () => {
  const { snapshot } = createDemo();
  const parsed = response(snapshot);
  const step = parsed.steps[0];
  const reference = step?.references[0];
  assert.ok(step && reference);
  assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, command: 'run something' }), snapshot, sent(snapshot)), /unexpected/);
  assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, steps: [{ ...step, references: [{ ...reference, path: '../x' }] }] }), snapshot, sent(snapshot)), /unexpected/);
  assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, steps: [{ ...step, references: [{ ...reference, side: 'current' }] }] }), snapshot, sent(snapshot)), /side/);
  assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, steps: [{ ...step, references: [reference, reference] }] }), snapshot, sent(snapshot)), /duplicate/);
  assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, skipped: [{ hunkId: reference.hunkId, reason: 'irrelevant' }] }), snapshot, sent(snapshot)), /already explained/);
});

test('output shape and prose lengths are bounded', () => {
  const { snapshot } = createDemo();
  const parsed = response(snapshot);
  const step = parsed.steps[0];
  assert.ok(step);
  for (const steps of [
    [{ ...step, references: [] }],
    [{ ...step, title: 'x'.repeat(121) }],
    [{ ...step, explanation: '' }],
    new Array(25).fill(step),
  ]) {
    assert.throws(() => validatePlanResponse(JSON.stringify({ ...parsed, steps }), snapshot, sent(snapshot)), /invalid walkthrough/);
  }
});

test('an empty walkthrough never hides unsupported or unmentioned changes', () => {
  const { snapshot } = createDemo();
  const coverage = createCoverage(snapshot);
  assert.equal(coverage.length, 6);
  assert.ok(coverage.every((entry) => entry.status !== 'explained'));
});
