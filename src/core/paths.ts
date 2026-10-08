import * as path from 'node:path';
import { LinebeamError } from './errors';

export function validateRepositoryPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes(':') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw new LinebeamError(`Unsafe or unsupported repository path: ${JSON.stringify(value)}`, 'unsafe-path');
  }
  return value;
}

export function resolveRepositoryPath(root: string, relativePath: string): string {
  validateRepositoryPath(relativePath);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (!isWithinRoot(root, absolute)) {
    throw new LinebeamError('A change points outside the open repository.', 'unsafe-path');
  }
  return absolute;
}

export function isWithinRoot(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function samePath(first: string, second: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}
