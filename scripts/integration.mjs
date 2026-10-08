import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unpackVerifiedVsix, verifyVsix } from './vsix.mjs';

const exec = promisify(execFile);
const project = resolve('.');
const packaged = process.argv.includes('--vsix');
if (process.argv.slice(2).some((argument) => argument !== '--vsix')) {
  throw new Error('Usage: node scripts/integration.mjs [--vsix]');
}
if (process.env.VSCODE_EXECUTABLE_PATH && process.env.VSCODE_TEST_VERSION) {
  throw new Error('Choose VSCODE_EXECUTABLE_PATH or VSCODE_TEST_VERSION, not both.');
}
if (packaged && process.env.LINEBEAM_EXTENSION_UNDER_TEST) {
  throw new Error('A packaged test cannot also use LINEBEAM_EXTENSION_UNDER_TEST.');
}
const verified = packaged ? await verifyVsix(process.env.LINEBEAM_VSIX, project) : undefined;
const unpacked = verified ? await mkdtemp(join(tmpdir(), 'linebeam-host-vsix-')) : undefined;
const fixture = await mkdtemp(join(tmpdir(), 'linebeam-host-fixture-'));
const profile = await mkdtemp(join(tmpdir(), 'linebeam-host-profile-'));
try {
  const extensionUnderTest = verified
    ? await unpackVerifiedVsix(verified, unpacked)
    : process.env.LINEBEAM_EXTENSION_UNDER_TEST || project;
  const manifest = JSON.parse(await readFile(join(extensionUnderTest, 'package.json'), 'utf8'));
  if (verified) console.log(`Testing packaged ${manifest.name}@${manifest.version}, SHA-256 ${verified.sha256}`);
  await mkdir(join(profile, 'User'));
  await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'workbench.enableExperiments': false,
  }));
  await mkdir(join(fixture, '.vscode'));
  await writeFile(join(fixture, '.vscode', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'workbench.editor.enablePreview': true,
    'diffEditor.renderSideBySide': true,
    'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false,
    'update.mode': 'none',
  }));
  // Settings-migration tests must not introduce text hunks that could reach a model.
  await writeFile(join(fixture, '.gitignore'), '.vscode/\n');
  await writeFile(join(fixture, 'baseline.ts'), 'export const baseline = true;\n');
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'],
    ['config', 'user.name', 'Linebeam Host Test'],
    ['config', 'user.email', 'linebeam@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'core.hooksPath', join(fixture, 'no-hooks')],
    ['add', '--all'],
    ['commit', '--quiet', '-m', 'fixture'],
  ]) {
    await exec('git', args, { cwd: fixture, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  }
  await writeFile(join(fixture, 'binary.bin'), Buffer.from([0, 1, 2]));
  await runTests({
    extensionDevelopmentPath: extensionUnderTest,
    extensionTestsPath: join(project, '.test-out', 'test', 'host', 'index.js'),
    extensionTestsEnv: {
      LINEBEAM_HOST_FIXTURE: fixture,
      LINEBEAM_EXTENSION_ID: `${manifest.publisher}.${manifest.name}`,
      LINEBEAM_EXPECTED_VSCODE_VERSION: process.env.VSCODE_TEST_VERSION || '',
    },
    ...(process.env.VSCODE_EXECUTABLE_PATH
      ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
      : { version: process.env.VSCODE_TEST_VERSION || 'stable' }),
    launchArgs: [
      fixture,
      '--user-data-dir', profile,
      '--extensions-dir', join(profile, 'extensions'),
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  });
} finally {
  if (unpacked) await rm(unpacked, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
