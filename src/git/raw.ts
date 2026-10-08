import { LinebeamError } from '../core/errors';
import { validateRepositoryPath } from '../core/paths';
import type { ChangeKind } from '../core/types';

export interface GitChange {
  readonly path: string;
  readonly oldPath: string;
  readonly kind: ChangeKind;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string | undefined;
  readonly newOid: string | undefined;
  readonly metadata: readonly string[];
}

export function gitText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new LinebeamError('Git returned a non-UTF-8 filename. This change scope is not supported.', 'git-encoding');
  }
}

export function parseNulList(value: string): string[] {
  if (value === '') {
    return [];
  }
  if (!value.endsWith('\0')) {
    throw new LinebeamError('Git returned an incomplete NUL-delimited file list.', 'git-format');
  }
  return value.slice(0, -1).split('\0');
}

export function parseRawChanges(raw: string): GitChange[] {
  const parts = parseNulList(raw);
  const changes = new Map<string, GitChange>();
  for (let cursor = 0; cursor < parts.length;) {
    const header = parts[cursor++];
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ACDMRTU])(\d{1,3})?$/.exec(header ?? '');
    if (!match) {
      throw new LinebeamError('Git returned an unsupported raw change record.', 'git-format');
    }
    const [, oldMode, newMode, oldHash, newHash, status] = match;
    const first = parts[cursor++];
    const second = status === 'R' || status === 'C' ? parts[cursor++] : first;
    if (!first || !second || !oldMode || !newMode || !oldHash || !newHash || !status) {
      throw new LinebeamError('Git returned an incomplete change record.', 'git-format');
    }
    validateRepositoryPath(first);
    validateRepositoryPath(second);
    const kindByStatus: Readonly<Record<string, ChangeKind>> = {
      A: 'added', C: 'added', D: 'deleted', M: 'modified', R: 'renamed', T: 'typechanged', U: 'unmerged',
    };
    const kind = kindByStatus[status];
    if (!kind) {
      throw new LinebeamError('Git returned an unknown change status.', 'git-format');
    }
    const change: GitChange = {
      path: second,
      oldPath: status === 'C' ? second : first,
      kind,
      oldMode: status === 'C' ? '000000' : oldMode,
      newMode,
      oldOid: /^0+$/.test(oldHash) || status === 'C' ? undefined : oldHash,
      newOid: /^0+$/.test(newHash) ? undefined : newHash,
      metadata: status === 'C' ? [`Copied from ${first}.`] : [],
    };
    const existing = changes.get(second);
    // Git can emit both U and M records for a conflicted working-tree file.
    if (existing?.kind === 'unmerged') {
      continue;
    }
    if (existing && change.kind !== 'unmerged') {
      throw new LinebeamError('Git returned duplicate paths in the comparison.', 'git-format');
    }
    changes.set(second, change);
  }
  return [...changes.values()];
}
