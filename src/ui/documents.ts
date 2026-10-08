import * as vscode from 'vscode';
import { LinebeamError } from '../core/errors';
import type { ReviewSnapshot, Side, SnapshotFile } from '../core/types';

// Keep the immutable document protocol stable across the product rename.
export const SNAPSHOT_SCHEME = 'diffquill';

export class SnapshotDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly snapshots = new Map<string, ReviewSnapshot>();
  private activeId: string | undefined;
  private readonly registration: vscode.Disposable;
  private readonly closeListener: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, this);
    this.closeListener = vscode.workspace.onDidCloseTextDocument(() => this.prune());
  }

  setActive(snapshot: ReviewSnapshot | undefined): void {
    this.activeId = snapshot?.id;
    if (snapshot) {
      this.snapshots.set(snapshot.id, snapshot);
    }
    this.prune();
  }

  uri(snapshot: ReviewSnapshot, file: SnapshotFile, side: Side): vscode.Uri {
    const content = side === 'old' ? file.before : file.after;
    return vscode.Uri.from({
      scheme: SNAPSHOT_SCHEME,
      authority: snapshot.id,
      path: `/${file.id}/${side}/${side === 'old' ? file.oldPath : file.path}`,
      query: new URLSearchParams({ file: file.id, side, content: content.id }).toString(),
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const snapshot = this.snapshots.get(uri.authority);
    const query = new URLSearchParams(uri.query);
    const file = snapshot?.files.find((candidate) => candidate.id === query.get('file'));
    const side = query.get('side');
    if (!snapshot || !file || (side !== 'old' && side !== 'new') || this.uri(snapshot, file, side).toString() !== uri.toString()) {
      throw new LinebeamError('This captured document is unavailable or its identifier is invalid. Regenerate the walkthrough.', 'snapshot-document');
    }
    const content = side === 'old' ? file.before : file.after;
    if (content.text === undefined) {
      throw new LinebeamError('This file has no captured UTF-8 text. Its omission reason is listed in All Changes.', 'unsupported-document');
    }
    return content.text;
  }

  private prune(): void {
    const openSnapshots = new Set(vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === SNAPSHOT_SCHEME)
      .map((document) => document.uri.authority));
    for (const id of this.snapshots.keys()) {
      if (id !== this.activeId && !openSnapshots.has(id)) {
        this.snapshots.delete(id);
      }
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.closeListener.dispose();
    this.snapshots.clear();
  }
}
