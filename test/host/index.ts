import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LinebeamApi } from '../../src/extension';
import { modelError } from '../../src/model/copilot';

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function run(): Promise<void> {
  const expectedVersion = process.env.LINEBEAM_EXPECTED_VSCODE_VERSION;
  if (expectedVersion && /^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    assert.equal(vscode.version, expectedVersion, 'The requested VS Code version must actually run');
  }
  console.log(`Linebeam smoke host: VS Code ${vscode.version}`);
  const extensionId = process.env.LINEBEAM_EXTENSION_ID;
  assert.ok(extensionId);
  const extension = vscode.extensions.getExtension<LinebeamApi>(extensionId);
  assert.ok(extension, 'Linebeam extension must be loaded');
  assert.equal(extensionId, 'lukiiiz22.linebeam');
  const api = await extension.activate();
  assert.match(modelError(vscode.LanguageModelError.NoPermissions('fixture consent denial')).message, /not granted/);
  assert.match(modelError(vscode.LanguageModelError.NotFound('fixture unavailable model')).message, /no longer available/);
  assert.match(modelError(vscode.LanguageModelError.Blocked('fixture quota')).message, /Quota, rate limits, or organization restrictions/);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['explainChanges', 'showDemo', 'next', 'previous', 'showAllChanges', 'clear']) {
    assert.ok(commands.includes(`linebeam.${name}`), `Command ${name} is registered`);
  }
  await vscode.commands.executeCommand('linebeam.showDemo');
  assert.equal(api.getState().review?.steps.length, 4);
  assert.equal(api.getState().selectedStep, 0);
  assert.equal(api.getState().canGoPrevious, false);
  assert.equal(api.getState().canGoNext, true);
  assert.equal(api.getState().coverageFilter, 'all');
  await eventually(() => vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'diffquill'),
  ), 'a native snapshot diff');
  assert.ok(vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.label.includes('Linebeam snapshot')),
  ), 'Native diff titles use the renamed product');
  const oldDocument = vscode.workspace.textDocuments.find((document) =>
    document.uri.scheme === 'diffquill' && document.uri.path.endsWith('/old/src/request.ts'),
  );
  const newDocument = vscode.workspace.textDocuments.find((document) =>
    document.uri.scheme === 'diffquill' && document.uri.path.endsWith('/new/src/request.ts'),
  );
  assert.ok(oldDocument && newDocument, 'Both immutable sides are open');
  assert.doesNotMatch(oldDocument.getText(), /HttpError/);
  assert.match(newDocument.getText(), /throw new HttpError/);
  assert.equal(newDocument.languageId, 'typescript');
  const snapshotText = newDocument.getText();
  const forged = newDocument.uri.with({ query: newDocument.uri.query.replace(/content=[^&]+/, 'content=forged') });
  await assert.rejects(async () => vscode.workspace.openTextDocument(forged), /identifier is invalid|unavailable/);

  await vscode.commands.executeCommand('linebeam.next');
  assert.equal(api.getState().selectedStep, 1);
  assert.equal(api.getState().canGoPrevious, true);
  assert.equal(api.getState().canGoNext, true);
  assert.equal(newDocument.getText(), snapshotText);
  await vscode.commands.executeCommand('linebeam.next');
  assert.equal(api.getState().selectedStep, 2);
  await eventually(() => vscode.workspace.textDocuments.some((document) =>
    document.uri.scheme === 'diffquill' && document.uri.path.endsWith('/old/src/legacy-client.ts'),
  ), 'the deletion old side');
  const deletion = vscode.workspace.textDocuments.find((document) => document.uri.path.endsWith('/old/src/legacy-client.ts'));
  assert.match(deletion?.getText() ?? '', /return null/);
  await vscode.commands.executeCommand('linebeam.next');
  await vscode.commands.executeCommand('linebeam.next');
  assert.equal(api.getState().selectedStep, 3, 'Next stays within the plan');
  assert.equal(api.getState().canGoNext, false);
  for (let index = 0; index < 5; index++) {
    await vscode.commands.executeCommand('linebeam.previous');
  }
  assert.equal(api.getState().selectedStep, 0, 'Previous stays within the plan');
  await vscode.commands.executeCommand('linebeam.showAllChanges');
  assert.equal(api.getState().screen, 'changes');
  assert.equal(api.getState().review?.summary.unsupported, 1);
  assert.equal(api.getState().review?.summary.metadata, 1);
  assert.equal(api.getState().coverageFilter, 'all');
  assert.ok(api.getState().review?.files.every((file) => file.entries.every((entry) => entry.matchesFilter)));

  // This fixture contains only a binary change, so capture must never contact a model.
  await vscode.commands.executeCommand('linebeam.explainChanges');
  assert.equal(api.getState().error, null);
  assert.equal(api.getState().review?.isDemo, false);
  assert.equal(api.getState().review?.files.length, 1);
  assert.equal(api.getState().review?.summary.unsupported, 1);
  assert.match(api.getState().notice ?? '', /No model request/);
  const fixture = process.env.LINEBEAM_HOST_FIXTURE;
  assert.ok(fixture);
  await fs.writeFile(path.join(fixture, 'binary.bin'), Buffer.from([0, 3, 4]));
  await vscode.commands.executeCommand('linebeam.showAllChanges');
  assert.match(api.getState().staleReason ?? '', /changed/);
  await vscode.commands.executeCommand('linebeam.clear');
  assert.equal(api.getState().review, null);
  assert.equal(api.getState().staleReason, null);
  assert.equal(api.getState().canGoPrevious, false);
  assert.equal(api.getState().canGoNext, false);
  assert.equal(api.getState().coverageFilter, 'all');
  const settingsPath = path.join(fixture, '.vscode', 'settings.json');
  const savedSettings = await fs.readFile(settingsPath, 'utf8');
  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      ...JSON.parse(savedSettings),
      'diffquill.excludeGlobs': ['private/**'],
    }));
    await eventually(() =>
      vscode.workspace.getConfiguration('diffquill').inspect<unknown>('excludeGlobs')?.workspaceValue !== undefined,
    'the explicit legacy privacy setting');
    await vscode.commands.executeCommand('linebeam.explainChanges');
    assert.match(api.getState().error ?? '', /Migrate the old DiffQuill settings/);
    assert.equal(api.getState().review, null, 'Legacy exclusions must not be ignored during a new capture');
  } finally {
    await fs.writeFile(settingsPath, savedSettings);
  }
  await vscode.commands.executeCommand('linebeam.clear');
  console.log('Linebeam extension-host smoke checks passed: renamed identity, activation, native diffs, old-side deletion, immutable URIs, navigation, coverage, real Git capture, freshness, clear, settings migration guard. No model was called.');
}
