const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { parseHTML } = require('linkedom');
const { createDemo } = require('../.test-out/src/fixtures/demo.js');
const { emptyPlan } = require('../.test-out/src/core/plan.js');
const { toSidebarState } = require('../.test-out/src/ui/state.js');

function mount() {
  const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>');
  const messages = [];
  const scrollTargets = [];
  const focusCalls = [];
  const layout = { panelTop: 80, panelHeight: 500, stepTop: 500, resultsTop: 850, controlsHeight: 130 };
  let focused = false;
  let activeElement = document.body;
  document.hasFocus = () => focused;
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });
  window.scrollY = 40;
  document.documentElement.scrollTop = 40;
  window.scrollTo = () => { throw new Error('Scrolling must stay inside the sidebar.'); };
  window.HTMLElement.prototype.scrollIntoView = () => { throw new Error('Do not scroll ancestor frames.'); };
  window.HTMLElement.prototype.focus = function (options) {
    activeElement = this;
    focusCalls.push({ element: this, options });
  };
  // Deterministic geometry verifies offset arithmetic independently of browser layout.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const scrollTop = document.querySelector('.sidebar-scroll')?.scrollTop ?? 0;
    let top;
    let height;
    if (this.classList.contains('sidebar-scroll')) {
      top = layout.panelTop;
      height = layout.panelHeight;
    } else if (this.classList.contains('coverage-controls')) {
      top = layout.panelTop;
      height = layout.controlsHeight;
    } else if (this.classList.contains('coverage-results') || this.classList.contains('step-card')) {
      scrollTargets.push(this);
      top = layout.panelTop + (this.classList.contains('step-card') ? layout.stepTop : layout.resultsTop) - scrollTop;
      height = 700;
    } else {
      throw new Error(`Unexpected geometry target: ${this.className}`);
    }
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300 };
  };
  const script = readFileSync(join(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
  runInNewContext(script, {
    document, window,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))) }),
  });
  return {
    document,
    messages,
    scrollTargets,
    layout,
    focusCalls,
    focus(element) { focused = true; activeElement = element; },
    blur() { focused = false; },
    outerScroll: () => [window.scrollY, document.documentElement.scrollTop],
    toggle(details, open) {
      details.open = open;
      details.dispatchEvent(new window.Event('toggle'));
    },
    render(state) {
      const event = new window.Event('message');
      event.data = state;
      window.dispatchEvent(event);
    },
  };
}

function viewState(walkthrough = createDemo(), overrides = {}) {
  return toSidebarState({
    scope: 'all', preferredModelName: 'Choose Copilot model', busy: false, progress: '',
    error: undefined, notice: undefined, walkthrough, stepIndex: 0, screen: 'walkthrough',
    staleReason: undefined, unsavedCount: 0, captureNote: undefined,
    coverageFilter: 'all', ...overrides,
  });
}

test('sidebar initializes and renders the offline walkthrough with evidence and navigation', () => {
  const ui = mount();
  assert.deepEqual(ui.messages, [{ type: 'ready' }]);
  assert.equal(ui.document.querySelector('.brand-name').textContent, 'Linebeam');
  const state = viewState();
  ui.render(state);
  assert.match(ui.document.body.textContent, /Make HTTP failures explicit/);
  assert.match(ui.document.body.textContent, /An explanation is not verification/);
  assert.equal(ui.document.querySelectorAll('.reference-button').length, 3);
  ui.document.querySelectorAll('.reference-button')[0].click();
  assert.deepEqual(ui.messages.at(-1), {
    type: 'reference', snapshotId: state.review.snapshotId, stepId: 'step-1', index: 0,
  });
  const next = [...ui.document.querySelectorAll('.step-navigation button')].find((button) => button.textContent.startsWith('Next'));
  next.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'action', action: 'next' });
});

test('generated prose, filenames and error strings are always rendered as text, not HTML', () => {
  const ui = mount();
  const state = viewState();
  const attack = '<img src=x onerror="globalThis.pwned=true"><script>pwned()</script>';
  state.review.steps[0].title = attack;
  state.review.steps[0].explanation = attack;
  state.review.steps[0].references[0].path = attack;
  state.error = attack;
  ui.render(state);
  assert.ok(ui.document.body.textContent.includes(attack));
  assert.equal(ui.document.querySelectorAll('img, script, iframe').length, 0);
  assert.equal(ui.document.querySelectorAll('[onerror]').length, 0);
});

test('All Changes includes unsupported and rename metadata and emits only opaque ids', () => {
  const ui = mount();
  const state = { ...viewState(), screen: 'changes' };
  ui.render(state);
  assert.equal(ui.document.querySelectorAll('.file-card').length, 6);
  assert.match(ui.document.body.textContent, /Binary image changes/);
  assert.match(ui.document.body.textContent, /Renamed from src\/parse.ts/);
  assert.ok([...ui.document.querySelectorAll('.open-file')].some((button) => button.disabled));
  ui.document.querySelector('.hunk-button').click();
  const message = ui.messages.at(-1);
  assert.equal(message.type, 'file');
  assert.equal(message.snapshotId, state.review.snapshotId);
  assert.ok(message.hunkId);
  assert.equal(message.path, undefined);
});

test('busy state disables navigation and duplicate requests but leaves Cancel enabled', () => {
  const ui = mount();
  const state = viewState();
  state.busy = true;
  state.progress = 'Explaining captured hunks...';
  ui.render(state);
  const buttons = [...ui.document.querySelectorAll('button')];
  assert.ok(buttons.find((button) => button.textContent === 'Cancel' && !button.disabled));
  assert.ok(buttons.filter((button) => button.textContent !== 'Cancel').every((button) => button.disabled));
  state.busy = false;
  ui.render(state);
  assert.equal(ui.document.querySelector('.explain').disabled, false);
});

test('an empty sidebar makes the scope and offline entry point discoverable', () => {
  const ui = mount();
  const empty = viewState();
  empty.review = null;
  ui.render(empty);
  assert.match(ui.document.body.textContent, /Understand the change/);
  assert.match(ui.document.body.textContent, /Explore the offline demo/);
  assert.match(ui.document.body.textContent, /All local changes/);
  assert.equal(ui.document.querySelector('.controls').open, true);
  assert.equal(ui.document.querySelector('.step-navigation').hidden, true);
});

test('navigation stays outside the scrolling content and updates boundaries without rebuilding its buttons', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough));
  const nav = ui.document.querySelector('.step-navigation');
  const [previous, next] = nav.querySelectorAll('button');
  assert.equal(nav.parentElement.id, 'app');
  assert.equal(nav.closest('.sidebar-scroll'), null);
  assert.equal(nav.hidden, false);
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(nav.querySelector('.step-counter').textContent, '1 / 4');
  ui.render(viewState(walkthrough, { stepIndex: 3 }));
  assert.equal(ui.document.querySelector('.step-navigation'), nav);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
  assert.equal(nav.querySelector('.step-counter').textContent, '4 / 4');
  ui.render(viewState(walkthrough, { stepIndex: 1, busy: true }));
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
  ui.render(viewState(walkthrough, { stepIndex: 1 }));
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, false);
  ui.render(viewState(walkthrough, { screen: 'changes' }));
  assert.equal(nav.hidden, true);
});

test('capture settings and snapshot details collapse for a review but preserve manual disclosure choices', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough, { scope: 'staged', captureNote: 'Two unsaved buffers excluded.' }));
  const controls = ui.document.querySelector('.controls');
  assert.equal(controls.open, false);
  assert.equal(ui.document.querySelector('.snapshot-details').open, false);
  assert.match(ui.document.querySelector('.capture-scope').textContent, /Staged only/);
  assert.match(ui.document.querySelector('.snapshot-meta').textContent, /Captured: All local changes/);
  assert.match(ui.document.querySelector('.snapshot-values').textContent, /Offline fixture baseline/);
  assert.match(ui.document.querySelector('.snapshot-details').textContent, /Two unsaved buffers excluded/);
  ui.toggle(controls, true);
  ui.toggle(ui.document.querySelector('.snapshot-details'), true);
  ui.render(viewState(walkthrough, { stepIndex: 1 }));
  assert.equal(controls.open, true);
  assert.equal(ui.document.querySelector('.snapshot-details').open, true);
  ui.render(viewState(createDemo()));
  assert.equal(controls.open, false);
  assert.equal(ui.document.querySelector('.snapshot-details').open, false);
});

test('coverage pills use singular labels and request a snapshot-bound filter', () => {
  const ui = mount();
  const state = viewState();
  ui.render(state);
  const pills = [...ui.document.querySelectorAll('.coverage-pill')];
  assert.deepEqual(pills.map((pill) => pill.textContent), ['1 unsupported file', '1 metadata change']);
  pills[0].click();
  assert.deepEqual(ui.messages.at(-1), { type: 'coverage', snapshotId: state.review.snapshotId, filter: 'unsupported' });
  assert.equal(ui.document.querySelectorAll('span.coverage-pill').length, 0);
});

test('filtered coverage opens matching reasons, reports its scope, and can return to all files', () => {
  const ui = mount();
  const walkthrough = createDemo();
  for (const [coverageFilter, expectedPath, reason] of [
    ['unsupported', 'assets/status.png', /Binary image changes/],
    ['metadata', 'src/decode.ts', /Renamed from src\/parse.ts/],
  ]) {
    ui.render(viewState(walkthrough, { coverageFilter, screen: 'changes' }));
    const cards = ui.document.querySelectorAll('.file-card');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].open, true);
    assert.equal(cards[0].querySelector('.file-path').textContent, expectedPath);
    assert.match(cards[0].textContent, reason);
    assert.match(ui.document.querySelector('.filter-result').textContent, /Showing 1 of 6 captured files/);
    const selected = ui.document.querySelector('.filter-button[aria-pressed="true"]');
    assert.ok(selected);
    const all = [...ui.document.querySelectorAll('.filter-button')].find((button) => button.textContent === 'All changes');
    all.click();
    assert.deepEqual(ui.messages.at(-1), { type: 'coverage', snapshotId: walkthrough.snapshot.id, filter: 'all' });
  }
  ui.render(viewState(walkthrough, { screen: 'changes' }));
  assert.equal(ui.document.querySelectorAll('.file-card').length, 6);
  assert.ok([...ui.document.querySelectorAll('.file-card')].every((card) => !card.open));
});

test('an empty coverage filter explains zero matches and provides a reset action', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough, { coverageFilter: 'unexplained', screen: 'changes' }));
  assert.equal(ui.document.querySelectorAll('.file-card').length, 0);
  assert.match(ui.document.querySelector('.all-changes').textContent, /No unexplained hunks in this snapshot/);
  ui.document.querySelector('.reset-filter').click();
  assert.deepEqual(ui.messages.at(-1), { type: 'coverage', snapshotId: walkthrough.snapshot.id, filter: 'all' });
});

test('a hunk filter hides metadata entries in the same file without losing them from All Changes', () => {
  const ui = mount();
  const demo = createDemo();
  const snapshot = {
    ...demo.snapshot,
    files: demo.snapshot.files.map((file, index) => index === 0 ? { ...file, metadata: ['Mode changed.'] } : file),
  };
  const walkthrough = { ...demo, snapshot, plan: emptyPlan(snapshot, 'No explanation yet.') };
  ui.render(viewState(walkthrough, { coverageFilter: 'unexplained', screen: 'changes' }));
  assert.equal(ui.document.querySelectorAll('.coverage-entry').length, 4);
  assert.ok([...ui.document.querySelectorAll('.coverage-entry')].every((entry) => entry.querySelector('.hunk-button')));
  ui.render(viewState(walkthrough, { screen: 'changes' }));
  assert.equal(ui.document.querySelectorAll('.coverage-entry').length, 7);
  assert.match(ui.document.querySelector('.all-changes').textContent, /Mode changed/);
});

test('navigation scrolls the step into view only on explicit view or step changes', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough));
  assert.equal(ui.scrollTargets.length, 0);
  const scrollArea = ui.document.querySelector('.sidebar-scroll');
  scrollArea.scrollTop = 200;
  ui.render(viewState(walkthrough, { staleReason: 'Saved file changed.' }));
  assert.equal(ui.scrollTargets.length, 0);
  assert.equal(scrollArea.scrollTop, 200);
  ui.render(viewState(walkthrough, { stepIndex: 1 }));
  assert.equal(ui.scrollTargets.length, 1);
  assert.equal(ui.scrollTargets[0].className, 'step-card');
  assert.equal(scrollArea.scrollTop, 488);
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'metadata' }));
  assert.equal(scrollArea.scrollTop, 708);
  assert.deepEqual(ui.outerScroll(), [40, 40]);
});

test('single-file snapshots and plural coverage labels use the correct noun forms', () => {
  const ui = mount();
  const state = viewState();
  state.review.files = state.review.files.slice(0, 1);
  state.review.summary.totalHunks = 1;
  state.review.summary.explained = 1;
  state.review.summary.unsupported = 2;
  state.review.summary.metadata = 2;
  ui.render(state);
  assert.match(ui.document.querySelector('.snapshot-meta').textContent, /1 file$/);
  assert.match(ui.document.querySelector('.coverage-count').textContent, /1 text hunk explained/);
  assert.deepEqual([...ui.document.querySelectorAll('.coverage-pill')].map((pill) => pill.textContent), ['2 unsupported files', '2 metadata changes']);
});

test('filter navigation reveals results below the measured filter controls inside the sidebar', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough));
  const scrollArea = ui.document.querySelector('.sidebar-scroll');
  scrollArea.scrollTop = 200;
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'unsupported' }));
  assert.equal(scrollArea.scrollTop, 708);
  const controls = ui.document.querySelector('.coverage-controls');
  const results = ui.document.querySelector('.coverage-results');
  assert.ok(controls.contains(ui.document.querySelector('.coverage-filters')));
  assert.ok(controls.contains(ui.document.querySelector('.filter-result')));
  assert.equal(results.getBoundingClientRect().top, controls.getBoundingClientRect().bottom + 12);
  assert.equal(results.querySelector('.file-card').open, true);
  assert.equal(ui.document.querySelector('.step-navigation').hidden, true);
  assert.deepEqual(ui.outerScroll(), [40, 40]);
});

test('result positioning adapts to wrapped controls and an offset viewport', () => {
  const ui = mount();
  const walkthrough = createDemo();
  for (const [index, controlsHeight] of [68, 136, 204].entries()) {
    ui.layout.panelTop = 350 + index * 20;
    ui.layout.controlsHeight = controlsHeight;
    ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: index % 2 ? 'metadata' : 'unsupported' }));
    const scrollArea = ui.document.querySelector('.sidebar-scroll');
    const results = ui.document.querySelector('.coverage-results').getBoundingClientRect();
    assert.equal(results.top - ui.layout.panelTop, controlsHeight + 12);
    assert.equal(scrollArea.scrollTop, 850 - controlsHeight - 12);
  }
  assert.deepEqual(ui.outerScroll(), [40, 40]);
});

test('reselecting an active coverage badge reveals its results even without a state change', () => {
  const ui = mount();
  const walkthrough = createDemo();
  const state = viewState(walkthrough, { screen: 'changes', coverageFilter: 'unsupported' });
  ui.render(state);
  const scrollArea = ui.document.querySelector('.sidebar-scroll');
  scrollArea.scrollTop = 1_200;
  const badge = ui.document.querySelector('.coverage-pill[aria-pressed="true"]');
  ui.focus(badge);
  badge.click();
  assert.equal(scrollArea.scrollTop, 708);
  assert.deepEqual(ui.messages.at(-1), { type: 'coverage', snapshotId: walkthrough.snapshot.id, filter: 'unsupported' });
  assert.equal(ui.document.activeElement, ui.document.querySelector('.filter-button[aria-pressed="true"]'));
  assert.equal(ui.focusCalls.at(-1).options.preventScroll, true);
  ui.render(state);
  assert.equal(scrollArea.scrollTop, 708);
});

test('filter acknowledgement places keyboard focus on the visible active filter', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough));
  const badge = [...ui.document.querySelectorAll('.coverage-pill')].find((element) => element.textContent === '1 metadata change');
  ui.focus(badge);
  badge.click();
  assert.equal(ui.document.querySelector('.sidebar-scroll').scrollTop, 0, 'Wait for the host to accept a different filter');
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'metadata' }));
  assert.equal(ui.document.activeElement.textContent, 'Metadata changes');
  assert.equal(ui.document.activeElement.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.focusCalls.at(-1).options.preventScroll, true);
});

test('passive changes neither scroll filtered results nor steal editor focus', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'metadata' }));
  const scrollArea = ui.document.querySelector('.sidebar-scroll');
  scrollArea.scrollTop = 950;
  const measured = ui.scrollTargets.length;
  ui.blur();
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'metadata', staleReason: 'Saved content changed.' }));
  assert.equal(scrollArea.scrollTop, 950);
  assert.equal(ui.scrollTargets.length, measured);
  assert.equal(ui.focusCalls.length, 0);
});

test('empty results are revealed with their filter context and scroll offsets never become negative', () => {
  const ui = mount();
  const walkthrough = createDemo();
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'unexplained' }));
  const results = ui.document.querySelector('.coverage-results');
  assert.match(results.textContent, /No unexplained hunks in this snapshot/);
  assert.ok(results.querySelector('.reset-filter'));
  assert.equal(ui.document.querySelector('.sidebar-scroll').scrollTop, 708);
  ui.layout.resultsTop = 40;
  ui.render(viewState(walkthrough, { screen: 'changes', coverageFilter: 'skipped' }));
  assert.equal(ui.document.querySelector('.sidebar-scroll').scrollTop, 0);
});

test('disclosures keep native summary semantics while using visible chevrons and a stronger details header', () => {
  const ui = mount();
  ui.render(viewState());
  const details = ui.document.querySelector('.snapshot-details');
  const summary = details.querySelector('summary');
  assert.equal(summary.textContent, 'Snapshot details');
  assert.equal(summary.getAttribute('role'), null);
  assert.equal(summary.parentElement.tagName, 'DETAILS');
  const css = readFileSync(join(__dirname, '..', 'media', 'sidebar.css'), 'utf8');
  assert.match(css, /\.disclosure-summary::before\s*\{[^}]*rotate\(-45deg\)/);
  assert.match(css, /details\[open\]\s*>\s*\.disclosure-summary::before\s*\{[^}]*rotate\(45deg\)/);
  assert.match(css, /\.snapshot-details\s*>\s*\.disclosure-summary\s*\{[^}]*font-weight:\s*600[^}]*color:\s*var\(--text\)/);
  assert.match(css, /\.coverage-controls\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.doesNotMatch(css, /\.disclosure-summary::after/);
});
