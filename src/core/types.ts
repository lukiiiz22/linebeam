export type ChangeScope = 'all' | 'staged' | 'unstaged';
export type Side = 'old' | 'new';
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'typechanged' | 'unmerged';

export const SCOPE_LABELS: Readonly<Record<ChangeScope, string>> = {
  all: 'All local changes',
  staged: 'Staged only',
  unstaged: 'Unstaged + untracked',
};

export const SCOPE_DESCRIPTIONS: Readonly<Record<ChangeScope, string>> = {
  all: 'HEAD -> saved working tree + non-ignored untracked files',
  staged: 'HEAD -> index; working-tree and untracked changes excluded',
  unstaged: 'Index -> saved working tree + non-ignored untracked files',
};

export const LIMITS = {
  files: 200,
  fileBytes: 256 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
  hunks: 400,
  responseCharacters: 128 * 1024,
  steps: 24,
  referencesPerStep: 12,
} as const;

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface SnapshotContent {
  readonly id: string;
  readonly bytes: number;
  readonly text?: string;
}

export interface ReviewHunk {
  readonly id: string;
  readonly header: string;
  readonly lines: readonly string[];
  readonly oldRanges: readonly LineRange[];
  readonly newRanges: readonly LineRange[];
}

export interface SnapshotFile {
  readonly id: string;
  readonly path: string;
  readonly oldPath: string;
  readonly kind: ChangeKind;
  readonly before: SnapshotContent;
  readonly after: SnapshotContent;
  readonly hunks: readonly ReviewHunk[];
  readonly metadata: readonly string[];
  readonly unsupportedReason?: string;
}

export interface WorktreeStamp {
  readonly path: string;
  readonly value: string;
  readonly method: 'content' | 'stat';
}

export interface ReviewSnapshot {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly repositoryName: string;
  readonly scope: ChangeScope;
  readonly capturedAt: string;
  readonly baseLabel: string;
  readonly files: readonly SnapshotFile[];
  readonly manifestFingerprint: string;
  readonly worktreeStamps: readonly WorktreeStamp[];
  readonly isDemo: boolean;
}

export interface SourceReference {
  readonly fileId: string;
  readonly hunkId: string;
  readonly side: Side;
  readonly ranges: readonly LineRange[];
}

export interface ReviewStep {
  readonly id: string;
  readonly title: string;
  readonly explanation: string;
  readonly significance: string;
  readonly question?: string;
  readonly references: readonly SourceReference[];
}

export type CoverageStatus = 'explained' | 'skipped' | 'unexplained' | 'unsupported';

export interface CoverageEntry {
  readonly fileId: string;
  readonly hunkId?: string;
  readonly status: CoverageStatus;
  readonly reason: string;
  readonly stepIds: readonly string[];
}

export interface ReviewPlan {
  readonly snapshotId: string;
  readonly steps: readonly ReviewStep[];
  readonly coverage: readonly CoverageEntry[];
}

export interface PreparedPrompt {
  readonly text: string;
  readonly includedHunkIds: ReadonlySet<string>;
  readonly omitted: ReadonlyMap<string, string>;
  readonly inputTokens: number;
}

export interface Walkthrough {
  readonly snapshot: ReviewSnapshot;
  readonly plan: ReviewPlan;
  readonly modelName: string;
}

export function isChangeScope(value: unknown): value is ChangeScope {
  return value === 'all' || value === 'staged' || value === 'unstaged';
}

export function allHunks(snapshot: ReviewSnapshot): readonly ReviewHunk[] {
  return snapshot.files.flatMap((file) => file.hunks);
}

export function freezeSnapshot(snapshot: ReviewSnapshot): ReviewSnapshot {
  for (const file of snapshot.files) {
    Object.freeze(file.before);
    Object.freeze(file.after);
    for (const hunk of file.hunks) {
      hunk.oldRanges.forEach(Object.freeze);
      hunk.newRanges.forEach(Object.freeze);
      Object.freeze(hunk.oldRanges);
      Object.freeze(hunk.newRanges);
      Object.freeze(hunk.lines);
      Object.freeze(hunk);
    }
    Object.freeze(file.hunks);
    Object.freeze(file.metadata);
    Object.freeze(file);
  }
  snapshot.worktreeStamps.forEach(Object.freeze);
  Object.freeze(snapshot.worktreeStamps);
  Object.freeze(snapshot.files);
  return Object.freeze(snapshot);
}
