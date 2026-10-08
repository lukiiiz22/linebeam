import {
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  type ChangeScope,
  type CoverageEntry,
  type CoverageStatus,
  type Walkthrough,
} from '../core/types';

export const COVERAGE_FILTERS = ['all', 'unexplained', 'unsupported', 'skipped', 'metadata'] as const;
export type CoverageFilter = typeof COVERAGE_FILTERS[number];

export function isCoverageFilter(value: unknown): value is CoverageFilter {
  return COVERAGE_FILTERS.some((filter) => filter === value);
}

export function matchesCoverageFilter(entry: Pick<CoverageEntry, 'hunkId' | 'status'>, filter: CoverageFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'unexplained': return entry.status === 'unexplained' && entry.hunkId !== undefined;
    case 'unsupported': return entry.status === 'unsupported';
    case 'skipped': return entry.status === 'skipped';
    case 'metadata': return entry.hunkId === undefined && entry.status !== 'unsupported';
  }
}

export interface SessionState {
  readonly scope: ChangeScope;
  readonly preferredModelName: string;
  readonly busy: boolean;
  readonly progress: string;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  readonly walkthrough: Walkthrough | undefined;
  readonly stepIndex: number;
  readonly screen: 'walkthrough' | 'changes';
  readonly coverageFilter: CoverageFilter;
  readonly staleReason: string | undefined;
  readonly unsavedCount: number;
  readonly captureNote: string | undefined;
}

export interface ReferenceView {
  readonly index: number;
  readonly fileId: string;
  readonly path: string;
  readonly side: string;
  readonly lines: string;
}

export interface StepView {
  readonly id: string;
  readonly title: string;
  readonly explanation: string;
  readonly significance: string;
  readonly question?: string;
  readonly references: readonly ReferenceView[];
}

export interface CoverageView {
  readonly hunkId?: string;
  readonly label: string;
  readonly status: CoverageStatus;
  readonly reason: string;
  readonly steps: readonly number[];
  readonly matchesFilter: boolean;
}

export interface FileView {
  readonly id: string;
  readonly path: string;
  readonly oldPath: string;
  readonly kind: string;
  readonly canOpen: boolean;
  readonly entries: readonly CoverageView[];
}

export interface ReviewView {
  readonly snapshotId: string;
  readonly repository: string;
  readonly capturedAt: string;
  readonly baseLabel: string;
  readonly scopeLabel: string;
  readonly scopeDescription: string;
  readonly modelName: string;
  readonly isDemo: boolean;
  readonly steps: readonly StepView[];
  readonly files: readonly FileView[];
  readonly summary: {
    readonly explained: number;
    readonly totalHunks: number;
    readonly skipped: number;
    readonly unexplained: number;
    readonly unsupported: number;
    readonly metadata: number;
  };
}

export interface SidebarState {
  readonly type: 'state';
  readonly scopeLabel: string;
  readonly scopeDescription: string;
  readonly preferredModelName: string;
  readonly busy: boolean;
  readonly progress: string;
  readonly error: string | null;
  readonly notice: string | null;
  readonly staleReason: string | null;
  readonly unsavedCount: number;
  readonly captureNote: string | null;
  readonly screen: 'walkthrough' | 'changes';
  readonly coverageFilter: CoverageFilter;
  readonly selectedStep: number;
  readonly canGoPrevious: boolean;
  readonly canGoNext: boolean;
  readonly review: ReviewView | null;
}

export function toSidebarState(state: SessionState): SidebarState {
  const walkthrough = state.walkthrough;
  const count = walkthrough?.plan.steps.length ?? 0;
  const canNavigate = !state.busy && Number.isSafeInteger(state.stepIndex) && state.stepIndex >= 0 && state.stepIndex < count;
  let review: ReviewView | null = null;
  if (walkthrough) {
    const { snapshot, plan } = walkthrough;
    const files = new Map(snapshot.files.map((file) => [file.id, file]));
    const stepNumbers = new Map(plan.steps.map((step, index) => [step.id, index + 1]));
    review = {
      snapshotId: snapshot.id,
      repository: snapshot.repositoryName,
      capturedAt: snapshot.capturedAt,
      baseLabel: snapshot.baseLabel,
      scopeLabel: SCOPE_LABELS[snapshot.scope],
      scopeDescription: SCOPE_DESCRIPTIONS[snapshot.scope],
      modelName: walkthrough.modelName,
      isDemo: snapshot.isDemo,
      steps: plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        explanation: step.explanation,
        significance: step.significance,
        ...(step.question ? { question: step.question } : {}),
        references: step.references.map((reference, index) => ({
          index,
          fileId: reference.fileId,
          path: reference.side === 'old'
            ? files.get(reference.fileId)?.oldPath ?? reference.fileId
            : files.get(reference.fileId)?.path ?? reference.fileId,
          side: reference.side,
          lines: reference.ranges.map((range) => range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`).join(', '),
        })),
      })),
      files: snapshot.files.map((file) => ({
        id: file.id,
        path: file.path,
        oldPath: file.oldPath,
        kind: file.kind,
        canOpen: file.before.text !== undefined && file.after.text !== undefined,
        entries: plan.coverage.filter((entry) => entry.fileId === file.id).map((entry) => ({
          ...(entry.hunkId ? { hunkId: entry.hunkId } : {}),
          label: entry.hunkId ? file.hunks.find((hunk) => hunk.id === entry.hunkId)?.header ?? 'Captured hunk' : 'File-level change',
          status: entry.status,
          reason: entry.reason,
          matchesFilter: matchesCoverageFilter(entry, state.coverageFilter),
          steps: entry.stepIds.flatMap((id) => {
            const number = stepNumbers.get(id);
            return number === undefined ? [] : [number];
          }),
        })),
      })),
      summary: {
        explained: plan.coverage.filter((entry) => entry.hunkId && entry.status === 'explained').length,
        totalHunks: snapshot.files.reduce((total, file) => total + file.hunks.length, 0),
        skipped: plan.coverage.filter((entry) => entry.status === 'skipped').length,
        unexplained: plan.coverage.filter((entry) => entry.hunkId && entry.status === 'unexplained').length,
        unsupported: plan.coverage.filter((entry) => entry.status === 'unsupported').length,
        metadata: plan.coverage.filter((entry) => !entry.hunkId && entry.status !== 'unsupported').length,
      },
    };
  }
  return {
    type: 'state',
    scopeLabel: SCOPE_LABELS[state.scope],
    scopeDescription: SCOPE_DESCRIPTIONS[state.scope],
    preferredModelName: state.preferredModelName,
    busy: state.busy,
    progress: state.progress,
    error: state.error ?? null,
    notice: state.notice ?? null,
    staleReason: state.staleReason ?? null,
    unsavedCount: state.unsavedCount,
    captureNote: state.captureNote ?? null,
    screen: state.screen,
    coverageFilter: state.coverageFilter,
    selectedStep: state.stepIndex,
    canGoPrevious: canNavigate && state.stepIndex > 0,
    canGoNext: canNavigate && state.stepIndex < count - 1,
    review,
  };
}

const ACTIONS = ['explain', 'scope', 'model', 'previous', 'next', 'all', 'walkthrough', 'demo', 'cancel', 'clear'] as const;
type Action = typeof ACTIONS[number];

export type SidebarMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'action'; readonly action: Action }
  | { readonly type: 'step'; readonly snapshotId: string; readonly index: number }
  | { readonly type: 'reference'; readonly snapshotId: string; readonly stepId: string; readonly index: number }
  | { readonly type: 'coverage'; readonly snapshotId: string; readonly filter: CoverageFilter }
  | { readonly type: 'file'; readonly snapshotId: string; readonly fileId: string; readonly hunkId?: string };

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseSidebarMessage(value: unknown): SidebarMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.type === 'ready' && onlyKeys(message, ['type'])) {
    return { type: 'ready' };
  }
  if (message.type === 'action' && onlyKeys(message, ['type', 'action']) && typeof message.action === 'string') {
    const action = ACTIONS.find((candidate) => candidate === message.action);
    return action ? { type: 'action', action } : undefined;
  }
  if (typeof message.snapshotId !== 'string' || message.snapshotId.length > 100) {
    return undefined;
  }
  if (message.type === 'coverage' && isCoverageFilter(message.filter) && onlyKeys(message, ['type', 'snapshotId', 'filter'])) {
    return { type: 'coverage', snapshotId: message.snapshotId, filter: message.filter };
  }
  if ((message.type === 'step' || message.type === 'reference') && Number.isSafeInteger(message.index) && typeof message.index === 'number' && message.index >= 0) {
    if (message.type === 'step' && onlyKeys(message, ['type', 'snapshotId', 'index'])) {
      return { type: 'step', snapshotId: message.snapshotId, index: message.index };
    }
    if (message.type === 'reference' && typeof message.stepId === 'string' && message.stepId.length < 100 && onlyKeys(message, ['type', 'snapshotId', 'stepId', 'index'])) {
      return { type: 'reference', snapshotId: message.snapshotId, stepId: message.stepId, index: message.index };
    }
  }
  if (message.type === 'file' && typeof message.fileId === 'string' && message.fileId.length < 100 &&
    (message.hunkId === undefined || (typeof message.hunkId === 'string' && message.hunkId.length < 100)) &&
    onlyKeys(message, ['type', 'snapshotId', 'fileId', 'hunkId'])) {
    return {
      type: 'file', snapshotId: message.snapshotId, fileId: message.fileId,
      ...(typeof message.hunkId === 'string' ? { hunkId: message.hunkId } : {}),
    };
  }
  return undefined;
}
