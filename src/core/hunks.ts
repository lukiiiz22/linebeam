import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import { LinebeamError } from './errors';
import type { LineRange, ReviewHunk } from './types';

export function contentId(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function appendLine(ranges: LineRange[], line: number): void {
  const last = ranges.at(-1);
  if (last?.end === line - 1) {
    ranges[ranges.length - 1] = { start: last.start, end: line };
  } else {
    ranges.push({ start: line, end: line });
  }
}

export function createHunks(snapshotId: string, fileId: string, before: string, after: string): ReviewHunk[] {
  // Git often stores LF while the saved working copy uses CRLF. Line numbers do not change.
  const normalize = (text: string): string => text.replace(/\r\n?/g, '\n');
  const patch = structuredPatch('before', 'after', normalize(before), normalize(after), '', '', {
    context: 3,
    timeout: 1_000,
    maxEditLength: 20_000,
  });
  if (!patch) {
    throw new LinebeamError('This text diff exceeded the computation limit.', 'diff-limit');
  }
  return patch.hunks.map((hunk, index) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const oldRanges: LineRange[] = [];
    const newRanges: LineRange[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        appendLine(oldRanges, oldLine++);
      } else if (line.startsWith('+')) {
        appendLine(newRanges, newLine++);
      } else if (line.startsWith(' ')) {
        oldLine++;
        newLine++;
      }
    }
    return {
      id: `h-${contentId(`${snapshotId}:${fileId}:${index}`).slice(0, 20)}`,
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines: hunk.lines,
      oldRanges,
      newRanges,
    };
  });
}
