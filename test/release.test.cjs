const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const noticesModule = import('../scripts/notices.mjs');
const vsixModule = import('../scripts/vsix.mjs');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'linebeam-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

async function put(root, path, contents) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test('notices cover actual bundled direct, scoped and nested dependencies, preserving license and NOTICE text', async (t) => {
  const root = await fixture(t);
  const { createThirdPartyNotices } = await noticesModule;
  const packages = [
    ['node_modules/alpha', 'alpha', 'LICENSE', 'Synthetic alpha license.\r\nKeep this notice.\r\n'],
    ['node_modules/@fixture/bravo', '@fixture/bravo', 'LICENSE.md', 'Synthetic bravo license.\n'],
    ['node_modules/alpha/node_modules/charlie', 'charlie', 'COPYING.txt', 'Synthetic charlie license.\n'],
  ];
  for (const [directory, name, file, text] of packages) {
    await put(root, join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    await put(root, join(directory, file), text);
  }
  await put(root, join('node_modules', 'alpha', 'NOTICE'), 'Additional required alpha notice.\n');
  const inputs = {
    'src/extension.ts': {},
    'node_modules/alpha/dist/index.js': {},
    'node_modules/alpha/dist/other.js': {},
    'node_modules/@fixture/bravo/index.js': {},
    'node_modules/alpha/node_modules/charlie/index.js': {},
  };
  const output = await createThirdPartyNotices({ inputs }, root);
  assert.equal((output.match(/alpha@1\.0\.0/g) || []).length, 1);
  for (const [, name, , text] of packages) {
    assert.ok(output.includes(`${name}@1.0.0`));
    assert.ok(output.includes(text.replace(/\r\n/g, '\n').trimEnd()));
  }
  assert.ok(output.includes('Additional required alpha notice.'));
  assert.equal(output, await createThirdPartyNotices({ inputs: Object.fromEntries(Object.entries(inputs).reverse()) }, root));
  assert.doesNotMatch(output, /src\/extension|linebeam-release-test-/);
});

test('missing or empty dependency licenses fail instead of producing incomplete notices', async (t) => {
  const root = await fixture(t);
  const { createThirdPartyNotices } = await noticesModule;
  const directory = join('node_modules', 'alpha');
  const inputs = { 'node_modules/alpha/index.js': {} };
  await put(root, join(directory, 'package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0', license: 'MIT' }));
  await assert.rejects(createThirdPartyNotices({ inputs }, root), /no license file/);
  await put(root, join(directory, 'LICENSE'), '\n');
  await assert.rejects(createThirdPartyNotices({ inputs }, root), /empty LICENSE/);
  await put(root, join(directory, 'package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }));
  await assert.rejects(createThirdPartyNotices({ inputs }, root), /no valid license metadata/);
  await assert.rejects(createThirdPartyNotices(undefined, root), /Bundling metadata is required/);
});

test('package verification requires the exact built runtime, assets, notices and extension identity', async (t) => {
  const root = await fixture(t);
  const { packagedSources, verifyPackageFiles, unpackVerifiedVsix } = await vsixModule;
  const manifest = { name: 'linebeam', version: '0.1.2', publisher: 'lukiiiz22' };
  const files = new Map([
    ['extension.vsixmanifest', Buffer.from('<Identity Publisher="lukiiiz22" Version="0.1.2" Id="linebeam"/><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />')],
    ['[Content_Types].xml', Buffer.from('<Types/>')],
  ]);
  for (const [name, source] of packagedSources) {
    const contents = name === 'extension/package.json' ? JSON.stringify(manifest) : `Synthetic content for ${name}\n`;
    await put(root, source, contents);
    files.set(name, Buffer.from(contents));
  }
  assert.ok(files.has('extension/dist/THIRD_PARTY_NOTICES.txt'));
  assert.deepEqual(await verifyPackageFiles(files, root), manifest);
  const unpacked = await unpackVerifiedVsix({ files }, join(root, 'unpacked'));
  assert.equal(await readFile(join(unpacked, 'dist', 'extension.js'), 'utf8'), files.get('extension/dist/extension.js').toString());

  const withoutNotices = new Map(files);
  withoutNotices.delete('extension/dist/THIRD_PARTY_NOTICES.txt');
  await assert.rejects(verifyPackageFiles(withoutNotices, root), /Missing or empty.*THIRD_PARTY_NOTICES/);
  const stale = new Map(files);
  stale.set('extension/dist/extension.js', Buffer.from('old build'));
  await assert.rejects(verifyPackageFiles(stale, root), /does not match the current build/);
  const wrongIdentity = new Map(files);
  wrongIdentity.set('extension.vsixmanifest', Buffer.from('<Identity Id="linebeam" Version="0.1.1" Publisher="lukiiiz22"/><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />'));
  await assert.rejects(verifyPackageFiles(wrongIdentity, root), /identity Version does not match/);
  const regularRelease = new Map(files);
  regularRelease.set('extension.vsixmanifest', Buffer.from('<Identity Id="linebeam" Version="0.1.2" Publisher="lukiiiz22"/>'));
  await assert.rejects(verifyPackageFiles(regularRelease, root), /marked as a Marketplace pre-release/);
  for (const name of ['extension/.env', 'extension/dist/extension.js.map', 'extension/../../outside.js']) {
    const unexpected = new Map(files);
    unexpected.set(name, Buffer.from('not permitted'));
    await assert.rejects(verifyPackageFiles(unexpected, root), /Unexpected VSIX entry/);
  }
});

test('an explicit VS Code version cannot be silently overridden by an executable path', () => {
  const result = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'integration.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, VSCODE_EXECUTABLE_PATH: 'unused', VSCODE_TEST_VERSION: '1.96.0' },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose VSCODE_EXECUTABLE_PATH or VSCODE_TEST_VERSION, not both/);
});

test('the extension manifest and release assets use the clean Linebeam identity', async () => {
  const root = join(__dirname, '..');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'linebeam');
  assert.equal(manifest.publisher, 'lukiiiz22');
  assert.match(manifest.displayName, /^Linebeam\b/);
  for (const command of manifest.contributes.commands) {
    assert.match(command.command, /^linebeam\./);
    assert.equal(command.category, 'Linebeam');
    if (command.enablement) assert.match(command.enablement, /^linebeam\./);
  }
  for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.match(key, /^linebeam\./);
  for (const color of manifest.contributes.colors) assert.match(color.id, /^linebeam\./);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'linebeam');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/linebeam.svg');
  assert.equal(manifest.contributes.views.linebeam[0].id, 'linebeam.walkthrough');
  assert.match(await readFile(join(root, 'media', 'linebeam.svg'), 'utf8'), /<svg\b/);
  const { packagedSources } = await vsixModule;
  assert.ok(packagedSources.has('extension/media/linebeam.svg'));
  assert.equal(packagedSources.has('extension/media/quill.svg'), false);
});
