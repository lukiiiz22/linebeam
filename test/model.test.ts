import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createDemo } from '../src/fixtures/demo';
import { preparePrompt } from '../src/core/prompt';
import { createHunks, contentId } from '../src/core/hunks';
import { generateWalkthrough, type TextModel } from '../src/model/generate';
import { LIMITS, type ReviewSnapshot, type SnapshotFile } from '../src/core/types';

const countTokens = async (text: string): Promise<number> => Math.ceil(text.length / 4);

function modelFor(snapshot: ReviewSnapshot, stream?: () => AsyncIterable<string>): { model: TextModel; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      maxInputTokens: 32_000,
      countTokens,
      async sendRequest() {
        calls++;
        return stream ? stream() : (async function* () {
          const value = JSON.stringify({
            snapshotId: snapshot.id,
            steps: [],
            skipped: snapshot.files.flatMap((file) => file.hunks.map((hunk) => ({ hunkId: hunk.id, reason: 'Fixture skip.' }))),
          });
          yield value.slice(0, 60);
          yield value.slice(60);
        })();
      },
    },
  };
}

test('the prompt includes bounded diff evidence but no unsupported file paths or repository root', async () => {
  const { snapshot } = createDemo();
  const prompt = await preparePrompt(snapshot, { maxInputTokens: 32_000, countTokens });
  assert.equal(prompt.includedHunkIds.size, 4);
  assert.match(prompt.text, /untrusted DATA/);
  assert.match(prompt.text, /no test execution results/);
  assert.match(prompt.text, /src\/request.ts/);
  assert.doesNotMatch(prompt.text, /assets\/status\.png/);
  assert.doesNotMatch(prompt.text, /repositoryRoot/);
});

test('whole hunks that cannot fit the context are omitted explicitly while smaller hunks still fit', async () => {
  const demo = createDemo();
  const text = 'const big = "' + 'x'.repeat(30_000) + '";\n';
  const file: SnapshotFile = {
    id: 'large',
    path: 'large.ts',
    oldPath: 'large.ts',
    kind: 'added',
    before: { id: contentId(''), text: '', bytes: 0 },
    after: { id: contentId(text), text, bytes: text.length },
    hunks: createHunks(demo.snapshot.id, 'large', '', text),
    metadata: [],
  };
  const snapshot = { ...demo.snapshot, files: [file, ...demo.snapshot.files] };
  const prompt = await preparePrompt(snapshot, { maxInputTokens: 5_000, countTokens });
  assert.ok(prompt.inputTokens <= 3_750);
  assert.ok(prompt.includedHunkIds.size > 0);
  assert.ok(file.hunks[0]);
  assert.ok(prompt.omitted.has(file.hunks[0].id));
  assert.doesNotMatch(prompt.text, /large\.ts/);
});

test('generation makes one model request and accepts a fully streamed, validated result', async () => {
  const { snapshot } = createDemo();
  const fake = modelFor(snapshot);
  const result = await generateWalkthrough(snapshot, fake.model);
  assert.equal(fake.calls(), 1);
  assert.equal(result.plan.snapshotId, snapshot.id);
  assert.equal(result.plan.coverage.filter((entry) => entry.status === 'skipped').length, 4);
});

test('malformed model responses are not repaired through additional billed requests', async () => {
  const { snapshot } = createDemo();
  const fake = modelFor(snapshot, async function* () { yield 'I cannot return JSON.'; });
  await assert.rejects(generateWalkthrough(snapshot, fake.model), /invalid walkthrough/);
  assert.equal(fake.calls(), 1);
});

test('stream failures surface and do not accept a partial response', async () => {
  const { snapshot } = createDemo();
  const fake = modelFor(snapshot, async function* () {
    yield '{"snapshotId":';
    throw new Error('connection interrupted');
  });
  await assert.rejects(generateWalkthrough(snapshot, fake.model), /connection interrupted/);
  assert.equal(fake.calls(), 1);
});

test('response limits reject oversized streamed output', async () => {
  const { snapshot } = createDemo();
  const fake = modelFor(snapshot, async function* () { yield 'x'.repeat(LIMITS.responseCharacters + 1); });
  await assert.rejects(generateWalkthrough(snapshot, fake.model), /size limit/);
});

test('cancellation prevents requests and rejects in-flight output', async () => {
  const { snapshot } = createDemo();
  const first = new AbortController();
  first.abort();
  const fake = modelFor(snapshot);
  await assert.rejects(generateWalkthrough(snapshot, fake.model, first.signal), /cancelled/);
  assert.equal(fake.calls(), 0);
  const second = new AbortController();
  const during = modelFor(snapshot, async function* () {
    yield '{';
    second.abort();
    yield '}';
  });
  await assert.rejects(generateWalkthrough(snapshot, during.model, second.signal), /cancelled/);
});

test('invalid or unusably small model contexts fail without sending code', async () => {
  const { snapshot } = createDemo();
  for (const maxInputTokens of [0, NaN, 50]) {
    const fake = modelFor(snapshot);
    await assert.rejects(generateWalkthrough(snapshot, { ...fake.model, maxInputTokens }), /context/);
    assert.equal(fake.calls(), 0);
  }
});
