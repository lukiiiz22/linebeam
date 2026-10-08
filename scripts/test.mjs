import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = join('.test-out', 'test');
const tests = (await readdir(directory))
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => join(directory, file));
tests.push(...(await readdir('test')).filter((file) => file.endsWith('.test.cjs')).map((file) => join('test', file)));
if (tests.length === 0) {
  throw new Error('No compiled unit tests found.');
}
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
