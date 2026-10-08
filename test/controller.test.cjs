const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const { createDemo } = require('../.test-out/src/fixtures/demo.js');
const { CancelledError } = require('../.test-out/src/core/errors.js');
const { SCOPE_LABELS } = require('../.test-out/src/core/types.js');

function harness(t, options = {}) {
  const commands = new Map();
  const contexts = new Map();
  const errors = [];
  const opened = [];
  const root = process.cwd();
  let receiveMessage;
  let latestSidebarState;
  let finishGeneration;
  let pendingSidebarShow;
  let modelCalls = 0;
  const captureConfigurations = [];
  let started;
  const modelStarted = new Promise((resolve) => { started = resolve; });
  const plans = new Map();
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  const memento = () => {
    const values = new Map();
    return { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: async (key, value) => { values.set(key, value); } };
  };
  class CancellationTokenSource {
    token = { isCancellationRequested: false, onCancellationRequested: event };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 1 },
    UIKind: { Desktop: 1 },
    env: { uiKind: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    RelativePattern: class {},
    Disposable: class { constructor(callback) { this.dispose = callback; } },
    CancellationTokenSource,
    Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
    commands: {
      registerCommand(name, action) {
        commands.set(name, action);
        return { dispose() { commands.delete(name); } };
      },
      async executeCommand(name, ...args) {
        if (name !== 'setContext') throw new Error(`Unexpected VS Code command: ${name}`);
        contexts.set(args[0], args[1]);
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      textDocuments: [],
      getConfiguration: (section) => ({
        get: (key, fallback) => section === 'linebeam' && Object.hasOwn(options.settings ?? {}, key) ? options.settings[key] : fallback,
        inspect: (key) => section === 'diffquill' ? options.legacySettings?.[key] : undefined,
      }),
      onDidChangeTextDocument: event,
      onDidSaveTextDocument: event,
      onDidCloseTextDocument: event,
      onDidChangeWorkspaceFolders: event,
      onDidChangeConfiguration: event,
      createFileSystemWatcher: () => ({
        onDidChange: event, onDidCreate: event, onDidDelete: event, dispose() {},
      }),
    },
    window: {
      state: { focused: false },
      createOutputChannel: () => ({ appendLine(message) { errors.push(message); }, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: event,
      onDidChangeWindowState: event,
      showErrorMessage: async (message) => { errors.push(message); },
      withProgress: async (_options, task) => task({ report() {} }, new CancellationTokenSource().token),
    },
  };
  const overrides = {
    vscode,
    './ui/documents': {
      SnapshotDocuments: class { setActive() {} dispose() {} },
    },
    './ui/renderer': {
      DiffRenderer: class {
        clear() {}
        dispose() {}
        async open(snapshot, file) { opened.push({ snapshotId: snapshot.id, fileId: file.id }); }
      },
    },
    './ui/sidebar': {
      WalkthroughSidebar: class {
        static viewId = 'linebeam.walkthrough';
        constructor(_uri, receive) { receiveMessage = receive; }
        update(state) { latestSidebarState = state; }
        async show() {
          if (pendingSidebarShow) {
            const pending = pendingSidebarShow;
            pendingSidebarShow = undefined;
            pending.entered();
            await pending.wait;
          }
        }
      },
    },
    './git/snapshot': {
      discoverRepository: async () => root,
      GitSnapshotService: class {
        constructor(root, exclusions) { this.root = root; captureConfigurations.push(exclusions); }
        async capture(scope) {
          const demo = createDemo();
          plans.set(demo.snapshot.id, demo.plan);
          return { ...demo.snapshot, repositoryRoot: root, scope, isDemo: false };
        }
        async hasChanged() { return false; }
      },
    },
    './model/copilot': {
      selectCopilotModel: async () => ({ id: 'fixture', name: 'Fixture model' }),
      explainWithCopilot: (snapshot, _model, signal) => {
        modelCalls++;
        return new Promise((resolve, reject) => {
          const cancel = () => reject(new CancelledError());
          signal.addEventListener('abort', cancel, { once: true });
          finishGeneration = () => {
            signal.removeEventListener('abort', cancel);
            resolve({ plan: plans.get(snapshot.id) });
          };
          started();
        });
      },
    },
  };
  const compiled = join(__dirname, '..', '.test-out', 'src');
  const module = { exports: {} };
  runInNewContext(readFileSync(join(compiled, 'extension.js'), 'utf8'), {
    module,
    exports: module.exports,
    AbortController,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    setTimeout,
    clearTimeout,
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (!name.startsWith('./')) throw new Error(`Unexpected extension import: ${name}`);
      return require(resolve(compiled, name));
    },
  });
  const context = { extensionUri: {}, workspaceState: memento(), globalState: memento(), subscriptions: [] };
  const api = module.exports.activate(context);
  t.after(() => context.subscriptions.forEach((item) => item.dispose()));
  return {
    api, contexts, errors, opened, modelStarted, captureConfigurations,
    sidebarState: () => latestSidebarState,
    modelCalls: () => modelCalls,
    finishGeneration: () => finishGeneration(),
    pauseNextSidebarShow() {
      let release;
      let entered;
      const wait = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { entered = resolve; });
      pendingSidebarShow = { wait, entered };
      return { started, release };
    },
    async command(name) {
      const action = commands.get(`linebeam.${name}`);
      assert.ok(action);
      await action();
    },
    receive: (message) => receiveMessage(message),
  };
}

test('controller publishes matching native navigation contexts through demo, boundaries and clear', async (t) => {
  const h = harness(t);
  assert.equal(h.contexts.get('linebeam.canGoNext'), false);
  await h.command('showDemo');
  assert.equal(h.contexts.get('linebeam.hasPlan'), true);
  assert.equal(h.contexts.get('linebeam.canGoPrevious'), false);
  assert.equal(h.contexts.get('linebeam.canGoNext'), true);
  for (let index = 0; index < 3; index++) await h.command('next');
  assert.equal(h.contexts.get('linebeam.canGoPrevious'), true);
  assert.equal(h.contexts.get('linebeam.canGoNext'), false);
  await h.command('next');
  assert.equal(h.api.getState().selectedStep, 3);
  await h.command('clear');
  assert.equal(h.contexts.get('linebeam.hasPlan'), false);
  assert.equal(h.contexts.get('linebeam.canGoPrevious'), false);
  assert.equal(h.contexts.get('linebeam.canGoNext'), false);
  assert.equal(h.sidebarState().review, null);
  assert.equal(h.modelCalls(), 0);
  assert.deepEqual(h.errors, []);
});

test('old explicit scope and privacy settings block capture rather than being silently dropped', async (t) => {
  for (const key of ['defaultScope', 'excludeGlobs']) {
    for (const level of [
      'globalValue', 'workspaceValue', 'workspaceFolderValue',
      'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue',
    ]) {
      await t.test(`${key} at ${level}`, async (subtest) => {
        const h = harness(subtest, {
          legacySettings: { [key]: { [level]: key === 'defaultScope' ? 'staged' : ['private/**'] } },
        });
        await h.command('showDemo');
        const snapshotId = h.api.getState().review.snapshotId;
        await h.command('explainChanges');
        assert.match(h.api.getState().error, /Migrate the old DiffQuill settings/);
        assert.ok(h.api.getState().error.includes(`diffquill.${key} -> linebeam.${key}`));
        assert.equal(h.api.getState().review.snapshotId, snapshotId);
        assert.equal(h.modelCalls(), 0);
        assert.equal(h.captureConfigurations.length, 0);
      });
    }
  }
});

test('Linebeam uses its renamed settings and does not treat legacy defaults as explicit configuration', async (t) => {
  const h = harness(t, {
    settings: { defaultScope: 'unstaged', excludeGlobs: ['private/**'] },
    legacySettings: { excludeGlobs: { defaultValue: ['legacy-default/**'] } },
  });
  assert.equal(h.api.getState().scopeLabel, SCOPE_LABELS.unstaged);
  const generation = h.command('explainChanges');
  await h.modelStarted;
  assert.deepEqual(h.captureConfigurations, [['private/**']]);
  h.finishGeneration();
  await generation;
  assert.equal(h.api.getState().review.scopeLabel, SCOPE_LABELS.unstaged);
  assert.equal(h.modelCalls(), 1);
  assert.deepEqual(h.errors, []);
});

test('coverage messages traverse the real controller without changing snapshots or opening editors', async (t) => {
  const h = harness(t);
  await h.command('showDemo');
  const snapshotId = h.api.getState().review.snapshotId;
  const openedCount = h.opened.length;
  await h.receive({ type: 'coverage', snapshotId, filter: 'unsupported' });
  const state = h.sidebarState();
  assert.equal(state.screen, 'changes');
  assert.equal(state.coverageFilter, 'unsupported');
  assert.equal(state.review.snapshotId, snapshotId);
  assert.equal(state.review.files.length, 6);
  assert.deepEqual(state.review.files.filter((file) => file.entries.some((entry) => entry.matchesFilter)).map((file) => file.path), ['assets/status.png']);
  assert.equal(h.opened.length, openedCount);
  await h.command('showAllChanges');
  assert.equal(h.api.getState().coverageFilter, 'all');
  await h.receive({ type: 'coverage', snapshotId, filter: 'metadata' });
  await h.command('showDemo');
  assert.equal(h.api.getState().coverageFilter, 'all');
  await assert.rejects(h.receive({ type: 'coverage', snapshotId, filter: 'metadata' }), /older snapshot/);
  await assert.rejects(h.receive({ type: 'coverage', snapshotId: h.api.getState().review.snapshotId, filter: 'exec' }), /unsupported sidebar action/);
  assert.equal(h.modelCalls(), 0);
});

test('busy generation disables native navigation and rejects filter actions until completion', async (t) => {
  const h = harness(t);
  await h.command('showDemo');
  const generation = h.command('explainChanges');
  await h.modelStarted;
  assert.equal(h.api.getState().busy, true);
  assert.equal(h.contexts.get('linebeam.canGoPrevious'), false);
  assert.equal(h.contexts.get('linebeam.canGoNext'), false);
  await assert.rejects(h.receive({
    type: 'coverage', snapshotId: h.api.getState().review.snapshotId, filter: 'unsupported',
  }), /being generated/);
  h.finishGeneration();
  await generation;
  assert.equal(h.api.getState().busy, false);
  assert.equal(h.contexts.get('linebeam.canGoPrevious'), false);
  assert.equal(h.contexts.get('linebeam.canGoNext'), true);
  assert.equal(h.modelCalls(), 1);
  assert.deepEqual(h.errors, []);
});

test('cancelled generation keeps coverage inspectable with no enabled step navigation', async (t) => {
  const h = harness(t);
  const generation = h.command('explainChanges');
  await h.modelStarted;
  await h.command('cancel');
  await generation;
  assert.equal(h.api.getState().busy, false);
  assert.equal(h.api.getState().review.steps.length, 0);
  assert.match(h.api.getState().notice, /cancelled/);
  assert.equal(h.contexts.get('linebeam.canGoPrevious'), false);
  assert.equal(h.contexts.get('linebeam.canGoNext'), false);
  await h.receive({
    type: 'coverage', snapshotId: h.api.getState().review.snapshotId, filter: 'unexplained',
  });
  assert.equal(h.api.getState().coverageFilter, 'unexplained');
  assert.equal(h.api.getState().review.summary.unexplained, 4);
  assert.equal(h.modelCalls(), 1);
  assert.deepEqual(h.errors, []);
});

test('a later coverage filter wins over an earlier pending walkthrough focus', async (t) => {
  const h = harness(t);
  await h.command('showDemo');
  const paused = h.pauseNextSidebarShow();
  const opening = h.command('openWalkthrough');
  await paused.started;
  await h.receive({ type: 'coverage', snapshotId: h.api.getState().review.snapshotId, filter: 'unsupported' });
  paused.release();
  await opening;
  assert.equal(h.api.getState().screen, 'changes');
  assert.equal(h.api.getState().coverageFilter, 'unsupported');
  assert.equal(h.opened.length, 1);
});

test('clearing while a demo view is opening does not reopen it or report a spurious error', async (t) => {
  const h = harness(t);
  const paused = h.pauseNextSidebarShow();
  const opening = h.command('showDemo');
  await paused.started;
  await h.command('clear');
  paused.release();
  await opening;
  assert.equal(h.api.getState().review, null);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.errors, []);
});
