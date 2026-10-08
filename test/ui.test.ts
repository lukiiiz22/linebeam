import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createDemo } from '../src/fixtures/demo';
import { emptyPlan, createCoverage } from '../src/core/plan';
import { COVERAGE_FILTERS, matchesCoverageFilter, parseSidebarMessage, toSidebarState, type SessionState } from '../src/ui/state';

function session(): SessionState {
  return {
    scope: 'staged',
    preferredModelName: 'Example preferred model',
    busy: false,
    progress: '',
    error: undefined,
    notice: undefined,
    walkthrough: createDemo(),
    stepIndex: 0,
    screen: 'walkthrough',
    coverageFilter: 'all',
    staleReason: undefined,
    unsavedCount: 2,
    captureNote: 'Unsaved buffers excluded.',
  };
}

test('the sidebar distinguishes next-capture settings from the actual captured scope and model', () => {
  const state = toSidebarState(session());
  assert.equal(state.scopeLabel, 'Staged only');
  assert.equal(state.review?.scopeLabel, 'All local changes');
  assert.equal(state.preferredModelName, 'Example preferred model');
  assert.match(state.review?.modelName ?? '', /Offline fixture/);
});

test('sidebar coverage separates text hunks, metadata and unsupported files', () => {
  const state = toSidebarState(session());
  assert.deepEqual(state.review?.summary, { explained: 4, totalHunks: 4, skipped: 0, unexplained: 0, unsupported: 1, metadata: 1 });
  assert.equal(state.review?.files.length, 6);
  assert.equal(state.review?.files.find((file) => file.path === 'assets/status.png')?.canOpen, false);
  assert.equal(state.review?.files.find((file) => file.path === 'src/decode.ts')?.canOpen, true);
});

test('webview state contains evidence labels but does not serialize snapshot code', () => {
  const state = toSidebarState(session());
  const reference = state.review?.steps[0]?.references[0];
  assert.equal(reference?.side, 'new');
  assert.equal(reference?.path, 'src/request.ts');
  assert.ok(reference?.lines);
  assert.doesNotMatch(JSON.stringify(state), /export async function fetchJson/);
  assert.equal(state.unsavedCount, 2);
});

test('stale and failure states remain visible while captured evidence remains usable', () => {
  const state = toSidebarState({ ...session(), staleReason: 'Saved file changed.', error: 'Model was blocked.' });
  assert.equal(state.staleReason, 'Saved file changed.');
  assert.equal(state.error, 'Model was blocked.');
  assert.equal(state.review?.steps.length, 4);
});

test('navigation availability is shared by the sidebar and native command contexts', () => {
  const state = session();
  const availability = (patch: Partial<SessionState>) => {
    const view = toSidebarState({ ...state, ...patch });
    return [view.canGoPrevious, view.canGoNext];
  };
  assert.deepEqual(availability({ stepIndex: 0 }), [false, true]);
  assert.deepEqual(availability({ stepIndex: 1 }), [true, true]);
  assert.deepEqual(availability({ stepIndex: 3 }), [true, false]);
  assert.deepEqual(availability({ stepIndex: 1, busy: true }), [false, false]);
  assert.deepEqual(availability({ walkthrough: undefined }), [false, false]);
  for (const stepIndex of [-1, 0.5, 4, NaN]) {
    assert.deepEqual(availability({ stepIndex }), [false, false]);
  }
  const walkthrough = state.walkthrough;
  assert.ok(walkthrough);
  assert.deepEqual(availability({
    walkthrough: { ...walkthrough, plan: emptyPlan(walkthrough.snapshot, 'Not generated.') },
  }), [false, false]);
});

test('native Previous and Next use enablement rather than disappearing at a boundary', () => {
  const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
    contributes: {
      commands: { command: string; enablement?: string }[];
      menus: { 'editor/title': { command: string; when: string }[] };
    };
  };
  for (const [command, context] of [
    ['linebeam.previous', 'linebeam.canGoPrevious'],
    ['linebeam.next', 'linebeam.canGoNext'],
  ]) {
    assert.equal(manifest.contributes.commands.find((entry) => entry.command === command)?.enablement, context);
    assert.equal(manifest.contributes.menus['editor/title'].find((entry) => entry.command === command)?.when, 'resourceScheme == diffquill && linebeam.hasPlan');
  }
});

test('coverage filters preserve the complete ledger and mark only matching entries', () => {
  const state = session();
  const all = toSidebarState(state);
  assert.ok(all.review?.files.every((file) => file.entries.every((entry) => entry.matchesFilter)));
  for (const [coverageFilter, expectedPaths] of [
    ['unsupported', ['assets/status.png']],
    ['metadata', ['src/decode.ts']],
    ['unexplained', []],
    ['skipped', []],
  ] as const) {
    const filtered = toSidebarState({ ...state, coverageFilter, screen: 'changes' });
    assert.equal(filtered.review?.files.length, all.review?.files.length);
    assert.deepEqual(filtered.review?.summary, all.review?.summary);
    assert.deepEqual(filtered.review?.files.filter((file) => file.entries.some((entry) => entry.matchesFilter)).map((file) => file.path), expectedPaths);
  }
});

test('unexplained hunks, metadata and unsupported files remain non-overlapping categories', () => {
  const hunk = { hunkId: 'h-1', status: 'unexplained' as const };
  const metadata = { status: 'unexplained' as const };
  const binary = { status: 'unsupported' as const };
  assert.equal(matchesCoverageFilter(hunk, 'unexplained'), true);
  assert.equal(matchesCoverageFilter(metadata, 'unexplained'), false);
  assert.equal(matchesCoverageFilter(binary, 'unexplained'), false);
  assert.equal(matchesCoverageFilter(metadata, 'metadata'), true);
  assert.equal(matchesCoverageFilter(binary, 'metadata'), false);
  assert.equal(matchesCoverageFilter({ hunkId: 'h-1', status: 'skipped' }, 'skipped'), true);
  assert.equal(matchesCoverageFilter({ hunkId: 'h-1', status: 'explained' }, 'unexplained'), false);
});

test('incomplete and intentionally skipped plans can be filtered without claiming explanation', () => {
  const state = session();
  const walkthrough = state.walkthrough;
  assert.ok(walkthrough);
  const hunkId = walkthrough.snapshot.files[0]?.hunks[0]?.id;
  assert.ok(hunkId);
  const plan = {
    snapshotId: walkthrough.snapshot.id,
    steps: [],
    coverage: createCoverage(walkthrough.snapshot, [], new Map([[hunkId, 'Fixture skip.']])),
  };
  const reviewState = { ...state, walkthrough: { ...walkthrough, plan } };
  for (const [coverageFilter, count] of [['unexplained', 3], ['skipped', 1], ['metadata', 1], ['unsupported', 1]] as const) {
    const view = toSidebarState({ ...reviewState, coverageFilter });
    assert.equal(view.review?.files.flatMap((file) => file.entries).filter((entry) => entry.matchesFilter).length, count);
    assert.equal(view.review?.summary.explained, 0);
    assert.equal(view.canGoNext, false);
  }
});

test('sidebar messages allow only explicit actions and snapshot-bound opaque ids', () => {
  assert.deepEqual(parseSidebarMessage({ type: 'action', action: 'next' }), { type: 'action', action: 'next' });
  assert.deepEqual(parseSidebarMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseSidebarMessage({ type: 'step', snapshotId: 's-1', index: 0 }), { type: 'step', snapshotId: 's-1', index: 0 });
  assert.deepEqual(parseSidebarMessage({ type: 'file', snapshotId: 's-1', fileId: 'f-1', hunkId: 'h-1' }), { type: 'file', snapshotId: 's-1', fileId: 'f-1', hunkId: 'h-1' });
  for (const filter of COVERAGE_FILTERS) {
    const message = { type: 'coverage', snapshotId: 's-1', filter };
    assert.deepEqual(parseSidebarMessage(message), message);
  }
  for (const message of [
    null,
    [],
    { type: 'action', action: 'workbench.action.terminal.new' },
    { type: 'action', action: 'next', command: 'exec' },
    { type: 'step', snapshotId: 's-1', index: -1 },
    { type: 'step', snapshotId: 's-1', index: 0.5 },
    { type: 'step', snapshotId: 's-1', index: '1' },
    { type: 'file', snapshotId: 's-1', path: '../private' },
    { type: 'reference', snapshotId: 's-1', index: 0 },
    { type: 'file', snapshotId: 's-1', fileId: 'f-1', url: 'command:execute' },
    { type: 'coverage', filter: 'unsupported' },
    { type: 'coverage', snapshotId: 's-1', filter: 'unknown' },
    { type: 'coverage', snapshotId: 's-1', filter: ['all'] },
    { type: 'coverage', snapshotId: 's-1', filter: 'all', path: '../private' },
  ]) {
    assert.equal(parseSidebarMessage(message), undefined);
  }
});
