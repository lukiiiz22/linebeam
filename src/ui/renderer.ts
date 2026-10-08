import * as vscode from 'vscode';
import { LinebeamError } from '../core/errors';
import type { ReviewSnapshot, SnapshotFile, SourceReference } from '../core/types';
import { SNAPSHOT_SCHEME, SnapshotDocuments } from './documents';

interface Selection {
  readonly snapshot: ReviewSnapshot;
  readonly file: SnapshotFile;
  readonly references: readonly SourceReference[];
  readonly note: string;
}

export class DiffRenderer implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('linebeam.highlightBackground'),
    borderColor: new vscode.ThemeColor('linebeam.highlightBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: new vscode.ThemeColor('linebeam.highlightBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly visibleListener: vscode.Disposable;
  private selection: Selection | undefined;
  private pending: Promise<void> = Promise.resolve();
  private requestId = 0;

  constructor(private readonly documents: SnapshotDocuments) {
    this.visibleListener = vscode.window.onDidChangeVisibleTextEditors(() => this.decorate(false));
  }

  open(
    snapshot: ReviewSnapshot,
    file: SnapshotFile,
    references: readonly SourceReference[] = [],
    note = 'Captured change for manual inspection. This is not a correctness verdict.',
  ): Promise<void> {
    if (file.before.text === undefined || file.after.text === undefined) {
      return Promise.reject(new LinebeamError(file.unsupportedReason ?? 'This file has no captured text.', 'unsupported-document'));
    }
    const id = ++this.requestId;
    const open = async (): Promise<void> => {
      if (id !== this.requestId) {
        return;
      }
      this.selection = { snapshot, file, references: references.filter((reference) => reference.fileId === file.id), note };
      const left = this.documents.uri(snapshot, file, 'old');
      const right = this.documents.uri(snapshot, file, 'new');
      const label = file.oldPath !== file.path ? `${file.oldPath} -> ${file.path}` : file.path;
      const newRange = references.find((reference) => reference.fileId === file.id && reference.side === 'new')?.ranges[0];
      await vscode.commands.executeCommand('vscode.diff', left, right, `${label} - Linebeam snapshot ${snapshot.id.slice(-6)}`, {
        preview: true,
        ...(newRange ? { selection: new vscode.Range(newRange.start - 1, 0, newRange.start - 1, 0) } : {}),
      } satisfies vscode.TextDocumentShowOptions);
      if (id === this.requestId) {
        this.decorate(true);
      }
    };
    // Each caller handles its own error. A failed navigation must not poison the next one.
    this.pending = this.pending.then(open, open);
    return this.pending;
  }

  private decorate(reveal: boolean): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== SNAPSHOT_SCHEME) {
        continue;
      }
      const selection = this.selection;
      if (!selection) {
        editor.setDecorations(this.decoration, []);
        continue;
      }
      const uri = editor.document.uri.toString();
      const matching = selection.references.filter((reference) =>
        this.documents.uri(selection.snapshot, selection.file, reference.side).toString() === uri,
      );
      const hover = new vscode.MarkdownString();
      hover.isTrusted = false;
      hover.supportHtml = false;
      hover.appendText(selection.note);
      const decorations = matching.flatMap((reference) => reference.ranges.map((range) => ({
        range: new vscode.Range(
          range.start - 1, 0,
          range.end - 1, editor.document.lineAt(range.end - 1).text.length,
        ),
        hoverMessage: hover,
      })));
      editor.setDecorations(this.decoration, decorations);
      if (reveal && decorations[0]) {
        editor.revealRange(decorations[0].range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  clear(): void {
    this.requestId++;
    this.selection = undefined;
    this.decorate(false);
  }

  dispose(): void {
    this.clear();
    this.visibleListener.dispose();
    this.decoration.dispose();
  }
}
