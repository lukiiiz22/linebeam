import { spawn } from 'node:child_process';
import { CancelledError, checkCancelled, LinebeamError } from '../core/errors';

interface GitOptions {
  readonly signal?: AbortSignal;
  readonly input?: string;
  readonly maxBytes?: number;
  readonly allowExitCodes?: readonly number[];
}

interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

export async function runGit(root: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  checkCancelled(options.signal);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) {
      delete environment[key];
    }
  }
  Object.assign(environment, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    LC_ALL: 'C',
  });
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', [
      '--no-pager',
      '--literal-pathspecs',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'color.ui=false',
      ...args,
    ], { cwd: root, env: environment, windowsHide: true, shell: false, stdio: 'pipe' });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: GitResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };
    const cancel = (): void => {
      child.kill();
      finish(new CancelledError());
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new LinebeamError('Git did not finish within 30 seconds. Narrow the change scope and retry.', 'git-timeout'));
    }, 30_000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(new LinebeamError(
        error.code === 'ENOENT' ? 'Git was not found. Install Git and make it available on PATH, then restart VS Code.' : `Git could not start: ${error.message}`,
        'git-unavailable',
      ));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        child.kill();
        finish(new LinebeamError('Git output exceeded the safety limit. Narrow the change scope.', 'git-output-limit'));
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= 64 * 1024) {
        errors.push(chunk);
      }
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        finish(error);
      }
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      if (code === null || (code !== 0 && !options.allowExitCodes?.includes(code))) {
        finish(new LinebeamError(`Git could not read the change scope: ${stderr.slice(0, 1_600) || `exit ${code}`}`, 'git-failed'));
      } else {
        finish(undefined, { stdout: Buffer.concat(output), stderr, code });
      }
    });
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) {
      cancel();
    }
  });
}
