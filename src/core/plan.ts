import { LinebeamError } from './errors';
import { validateRepositoryPath } from './paths';
import {
  LIMITS,
  type CoverageEntry,
  type ReviewHunk,
  type ReviewPlan,
  type ReviewSnapshot,
  type ReviewStep,
  type SnapshotFile,
  type SourceReference,
} from './types';

function invalid(message: string): never {
  throw new LinebeamError(`The model returned an invalid walkthrough: ${message}`, 'invalid-plan');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(`${label} contains an unexpected field.`);
  }
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    invalid(`${label} must be non-empty text of at most ${maxLength} characters.`);
  }
  return value.trim();
}

interface HunkLocation {
  readonly file: SnapshotFile;
  readonly hunk: ReviewHunk;
}

function hunkIndex(snapshot: ReviewSnapshot): Map<string, HunkLocation> {
  const index = new Map<string, HunkLocation>();
  for (const file of snapshot.files) {
    validateRepositoryPath(file.path);
    validateRepositoryPath(file.oldPath);
    for (const hunk of file.hunks) {
      if (index.has(hunk.id)) {
        invalid('Snapshot contains a duplicate hunk identifier.');
      }
      index.set(hunk.id, { file, hunk });
    }
  }
  return index;
}

function validateReference(
  value: unknown,
  index: ReadonlyMap<string, HunkLocation>,
  sentIds: ReadonlySet<string>,
): SourceReference {
  const reference = record(value, 'reference');
  keys(reference, ['hunkId', 'side'], 'reference');
  const id = text(reference.hunkId, 'hunkId', 100);
  const location = index.get(id);
  if (!location || !sentIds.has(id)) {
    invalid('A reference is not part of the submitted snapshot hunks.');
  }
  if (reference.side !== 'old' && reference.side !== 'new') {
    invalid('Reference side must be "old" or "new".');
  }
  const { file, hunk } = location;
  const side = reference.side;
  const ranges = side === 'old' ? hunk.oldRanges : hunk.newRanges;
  const content = side === 'old' ? file.before.text : file.after.text;
  if (content === undefined || ranges.length === 0) {
    invalid('A reference points to a side with no changed lines.');
  }
  const lineCount = content.split(/\r\n|\r|\n/).length;
  if (ranges.some((range) =>
    !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
    range.start < 1 || range.end < range.start || range.end > lineCount,
  )) {
    invalid('A referenced range is outside the immutable document.');
  }
  return Object.freeze({
    fileId: file.id,
    hunkId: id,
    side,
    ranges,
  });
}

export function createCoverage(
  snapshot: ReviewSnapshot,
  steps: readonly ReviewStep[] = [],
  skipped: ReadonlyMap<string, string> = new Map(),
  omitted: ReadonlyMap<string, string> = new Map(),
): readonly CoverageEntry[] {
  const explained = new Map<string, string[]>();
  for (const step of steps) {
    for (const reference of step.references) {
      const ids = explained.get(reference.hunkId) ?? [];
      if (!ids.includes(step.id)) {
        ids.push(step.id);
      }
      explained.set(reference.hunkId, ids);
    }
  }
  const entries: CoverageEntry[] = [];
  for (const file of snapshot.files) {
    if (file.unsupportedReason) {
      entries.push({
        fileId: file.id,
        status: 'unsupported',
        reason: file.unsupportedReason,
        stepIds: [],
      });
      continue;
    }
    for (const hunk of file.hunks) {
      const stepIds = explained.get(hunk.id);
      const skipReason = skipped.get(hunk.id);
      entries.push({
        fileId: file.id,
        hunkId: hunk.id,
        status: stepIds ? 'explained' : skipReason ? 'skipped' : 'unexplained',
        reason: stepIds
          ? 'Linked to a walkthrough step; this is not a correctness verdict.'
          : skipReason ?? omitted.get(hunk.id) ?? 'Not explained by the model.',
        stepIds: stepIds ?? [],
      });
    }
    if (file.metadata.length > 0 || file.hunks.length === 0) {
      entries.push({
        fileId: file.id,
        status: 'unexplained',
        reason: file.metadata.length > 0
          ? `${file.metadata.join(' ')} Metadata is not covered by line references.`
          : 'No text hunk: empty-file or line-ending-only change. Inspect the captured diff.',
        stepIds: [],
      });
    }
  }
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    stepIds: Object.freeze([...entry.stepIds]),
  })));
}

export function emptyPlan(snapshot: ReviewSnapshot, reason: string): ReviewPlan {
  const omitted = new Map(snapshot.files.flatMap((file) => file.hunks.map((hunk) => [hunk.id, reason] as const)));
  return Object.freeze({
    snapshotId: snapshot.id,
    steps: Object.freeze([]),
    coverage: createCoverage(snapshot, [], new Map(), omitted),
  });
}

export function validatePlanResponse(
  response: string,
  snapshot: ReviewSnapshot,
  sentIds: ReadonlySet<string>,
  omitted: ReadonlyMap<string, string> = new Map(),
): ReviewPlan {
  if (response.length > LIMITS.responseCharacters) {
    invalid('Response exceeded the size limit.');
  }
  const trimmed = response.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    invalid('Expected one JSON object, without prose or an incomplete stream.');
  }
  const root = record(parsed, 'plan');
  keys(root, ['snapshotId', 'steps', 'skipped'], 'plan');
  if (root.snapshotId !== snapshot.id) {
    invalid('The snapshot identifier does not match.');
  }
  if (!Array.isArray(root.steps) || root.steps.length > LIMITS.steps) {
    invalid(`steps must be an array of at most ${LIMITS.steps} items.`);
  }
  if (!Array.isArray(root.skipped) || root.skipped.length > LIMITS.hunks) {
    invalid('skipped must be a bounded array.');
  }
  const index = hunkIndex(snapshot);
  const steps = root.steps.map((value: unknown, stepIndex: number): ReviewStep => {
    const step = record(value, 'step');
    keys(step, ['title', 'explanation', 'significance', 'question', 'references'], 'step');
    if (!Array.isArray(step.references) || step.references.length < 1 || step.references.length > LIMITS.referencesPerStep) {
      invalid(`Each step needs 1-${LIMITS.referencesPerStep} references.`);
    }
    const references = step.references.map((reference: unknown) => validateReference(reference, index, sentIds));
    if (new Set(references.map((reference) => `${reference.hunkId}:${reference.side}`)).size !== references.length) {
      invalid('A step contains a duplicate reference.');
    }
    const question = step.question === undefined ? undefined : text(step.question, 'question', 600);
    return Object.freeze({
      id: `step-${stepIndex + 1}`,
      title: text(step.title, 'title', 120),
      explanation: text(step.explanation, 'explanation', 1_200),
      significance: text(step.significance, 'significance', 800),
      ...(question ? { question } : {}),
      references: Object.freeze(references),
    });
  });
  const explainedIds = new Set(steps.flatMap((step) => step.references.map((reference) => reference.hunkId)));
  const skipped = new Map<string, string>();
  for (const value of root.skipped) {
    const skip = record(value, 'skipped item');
    keys(skip, ['hunkId', 'reason'], 'skipped item');
    const id = text(skip.hunkId, 'skipped hunkId', 100);
    if (!index.has(id) || !sentIds.has(id) || explainedIds.has(id) || skipped.has(id)) {
      invalid('A skipped hunk is unknown, duplicated, not submitted, or already explained.');
    }
    skipped.set(id, text(skip.reason, 'skip reason', 600));
  }
  return Object.freeze({
    snapshotId: snapshot.id,
    steps: Object.freeze(steps),
    coverage: createCoverage(snapshot, steps, skipped, omitted),
  });
}
