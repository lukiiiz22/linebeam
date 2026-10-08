import { randomUUID } from 'node:crypto';
import { contentId, createHunks } from '../core/hunks';
import { validatePlanResponse } from '../core/plan';
import { freezeSnapshot, type ChangeKind, type SnapshotFile, type Walkthrough } from '../core/types';

export function createDemo(): Walkthrough {
  const id = `demo-${randomUUID()}`;
  const file = (index: number, path: string, before: string, after: string, kind: ChangeKind = 'modified'): SnapshotFile => {
    const fileId = `f-${index}`;
    return {
      id: fileId,
      path,
      oldPath: path,
      kind,
      before: { id: contentId(before), text: before, bytes: Buffer.byteLength(before) },
      after: { id: contentId(after), text: after, bytes: Buffer.byteLength(after) },
      hunks: createHunks(id, fileId, before, after),
      metadata: [],
    };
  };
  const request = file(1, 'src/request.ts',
    'export async function fetchJson(url: string) {\n  const response = await fetch(url);\n  return response.json();\n}\n',
    'import { HttpError } from "./errors";\n\nexport async function fetchJson(url: string, signal?: AbortSignal) {\n  const response = await fetch(url, { signal });\n  if (!response.ok) {\n    throw new HttpError(response.status);\n  }\n  return response.json();\n}\n',
  );
  const errors = file(2, 'src/errors.ts', '',
    'export class HttpError extends Error {\n  constructor(readonly status: number) {\n    super(`HTTP request failed: ${status}`);\n    this.name = "HttpError";\n  }\n}\n',
    'added',
  );
  const legacy = file(3, 'src/legacy-client.ts',
    'export async function tryFetch(url: string) {\n  try {\n    return await fetch(url).then(response => response.json());\n  } catch {\n    return null;\n  }\n}\n',
    '', 'deleted',
  );
  const tests = file(4, 'test/request.test.ts', '',
    'import { expect, test, vi } from "vitest";\nimport { fetchJson } from "../src/request";\nimport { HttpError } from "../src/errors";\n\ntest("rejects non-success responses", async () => {\n  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));\n  await expect(fetchJson("/items")).rejects.toBeInstanceOf(HttpError);\n  vi.unstubAllGlobals();\n});\n',
    'added',
  );
  const renamedBase = file(5, 'src/decode.ts', 'export const decode = JSON.parse;\n', 'export const decode = JSON.parse;\n', 'renamed');
  const renamed: SnapshotFile = {
    ...renamedBase,
    oldPath: 'src/parse.ts',
    metadata: ['Renamed from src/parse.ts.'],
  };
  const binary: SnapshotFile = {
    id: 'f-6',
    path: 'assets/status.png',
    oldPath: 'assets/status.png',
    kind: 'modified',
    before: { id: 'demo-binary-old', bytes: 480 },
    after: { id: 'demo-binary-new', bytes: 520 },
    hunks: [],
    metadata: [],
    unsupportedReason: 'Binary image changes are visible here but are not sent to the model.',
  };
  const snapshot = freezeSnapshot({
    id,
    repositoryRoot: '',
    repositoryName: 'Example HTTP client',
    scope: 'all',
    capturedAt: new Date().toISOString(),
    baseLabel: 'Offline fixture baseline',
    files: [request, errors, legacy, tests, renamed, binary],
    manifestFingerprint: 'demo',
    worktreeStamps: [],
    isDemo: true,
  });
  const hunkId = (entry: SnapshotFile): string => {
    const hunk = entry.hunks[0];
    if (!hunk) {
      throw new Error('The demo fixture must have a text hunk.');
    }
    return hunk.id;
  };
  const plan = validatePlanResponse(JSON.stringify({
    snapshotId: id,
    steps: [
      {
        title: 'Make HTTP failures explicit',
        explanation: 'fetchJson now checks response.ok and throws HttpError for non-success responses. The new error type preserves the HTTP status for callers.',
        significance: 'Previously, even an error response was sent straight to JSON parsing. Callers can now distinguish HTTP failures from successful payloads.',
        question: 'Do existing callers handle rejected requests, and do they need more than the status code to show a useful error?',
        references: [
          { hunkId: hunkId(request), side: 'new' },
          { hunkId: hunkId(request), side: 'old' },
          { hunkId: hunkId(errors), side: 'new' },
        ],
      },
      {
        title: 'Carry cancellation to the network',
        explanation: 'The optional AbortSignal argument is forwarded to fetch. The existing single-argument call shape is still accepted.',
        significance: 'A caller can stop an obsolete request instead of waiting for it to complete. This diff does not show whether callers actually pass a signal.',
        question: 'Where should the caller create and abort its controller?',
        references: [{ hunkId: hunkId(request), side: 'new' }],
      },
      {
        title: 'Remove the null-on-error helper',
        explanation: 'The deleted tryFetch helper swallowed every exception and returned null. Its entire implementation is available on the old side of this immutable diff.',
        significance: 'This removes a fallback that could hide request failures. The captured hunks do not establish whether all imports have been migrated.',
        question: 'Are there remaining consumers of tryFetch?',
        references: [{ hunkId: hunkId(legacy), side: 'old' }],
      },
      {
        title: 'Describe the expected failure contract',
        explanation: 'The added test supplies a 503 response and expects an HttpError rejection.',
        significance: 'This documents one intended behavior. Linking a test is not evidence that it ran or passed; cancellation and successful responses are not covered by this fixture.',
        references: [{ hunkId: hunkId(tests), side: 'new' }],
      },
    ],
    skipped: [],
  }), snapshot, new Set(snapshot.files.flatMap((entry) => entry.hunks.map((hunk) => hunk.id))));
  return { snapshot, plan, modelName: 'Offline fixture - no model request' };
}
