const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

function harness() {
  const commands = [];
  const events = [];
  const uri = (snapshot, file, side) => ({
    scheme: 'diffquill',
    toString: () => `diffquill://${snapshot.id}/${file.id}/${side}`,
  });
  const snapshot = { id: 's-1' };
  const file = {
    id: 'f-1', path: 'file.ts', oldPath: 'file.ts',
    before: { text: 'context\nold\ncontext\n' },
    after: { text: 'context\nnew\ncontext\n' },
  };
  const editors = ['old', 'new'].map((side) => ({
    document: { uri: uri(snapshot, file, side), lineAt: () => ({ text: 'old' }) },
    ranges: [],
    reveals: [],
    setDecorations(_type, ranges) { this.ranges = ranges; },
    revealRange(range) { this.reveals.push(range); },
  }));
  const decoration = { dispose() {} };
  const vscode = {
    window: {
      visibleTextEditors: editors,
      createTextEditorDecorationType: () => decoration,
      onDidChangeVisibleTextEditors: (callback) => { events.push(callback); return { dispose() {} }; },
    },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    MarkdownString: class { appendText(text) { this.value = text; } },
    OverviewRulerLane: { Center: 2 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  };
  const module = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, '..', '.test-out', 'src', 'ui', 'renderer.js'), 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === './documents') return { SNAPSHOT_SCHEME: 'diffquill' };
      if (name === '../core/errors') return require('../.test-out/src/core/errors.js');
      throw new Error(`Unexpected renderer import: ${name}`);
    },
  });
  const renderer = new module.exports.DiffRenderer({ uri });
  const references = ['old', 'new'].map((side) => ({
    fileId: file.id, hunkId: 'h-1', side, ranges: [{ start: 2, end: 2 }],
  }));
  return { renderer, snapshot, file, references, editors, commands, events };
}

test('native diff rendering highlights exactly the referenced old/new changed lines', async () => {
  const h = harness();
  await h.renderer.open(h.snapshot, h.file, h.references, '<b>Untrusted explanation</b>');
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0][0], 'vscode.diff');
  assert.equal(h.commands[0][1].toString(), 'diffquill://s-1/f-1/old');
  assert.equal(h.commands[0][2].toString(), 'diffquill://s-1/f-1/new');
  for (const editor of h.editors) {
    assert.equal(editor.ranges.length, 1);
    assert.equal(editor.ranges[0].range.start.line, 1);
    assert.equal(editor.ranges[0].range.end.line, 1);
    assert.equal(editor.ranges[0].hoverMessage.isTrusted, false);
    assert.equal(editor.ranges[0].hoverMessage.supportHtml, false);
    assert.equal(editor.reveals.length, 1);
  }
});

test('visibility events decorate but never move the editor or open another diff', async () => {
  const h = harness();
  await h.renderer.open(h.snapshot, h.file, h.references);
  h.events[0]();
  assert.equal(h.commands.length, 1);
  assert.ok(h.editors.every((editor) => editor.reveals.length === 1));
  h.renderer.clear();
  assert.ok(h.editors.every((editor) => editor.ranges.length === 0));
});

test('queued navigation honors the latest explicit request and clear cancels pending focus changes', async () => {
  const h = harness();
  const first = h.renderer.open(h.snapshot, h.file, h.references);
  const second = h.renderer.open(h.snapshot, h.file, [], 'Manual inspection');
  await Promise.all([first, second]);
  assert.equal(h.commands.length, 1);
  assert.ok(h.editors.every((editor) => editor.ranges.length === 0));
  const pending = h.renderer.open(h.snapshot, h.file, h.references);
  h.renderer.clear();
  await pending;
  assert.equal(h.commands.length, 1);
});
