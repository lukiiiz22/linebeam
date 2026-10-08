import * as vscode from 'vscode';
import { CancelledError, checkCancelled, LinebeamError, errorMessage, isCancelled } from './core/errors';
import { isWithinRoot } from './core/paths';
import { emptyPlan } from './core/plan';
import {
  isChangeScope,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  type ChangeScope,
  type ReviewSnapshot,
  type SourceReference,
  type Walkthrough,
} from './core/types';
import { createDemo } from './fixtures/demo';
import { discoverRepository, GitSnapshotService } from './git/snapshot';
import { explainWithCopilot, selectCopilotModel } from './model/copilot';
import { SnapshotDocuments } from './ui/documents';
import { DiffRenderer } from './ui/renderer';
import { WalkthroughSidebar } from './ui/sidebar';
import { parseSidebarMessage, toSidebarState, type CoverageFilter, type SessionState, type SidebarState } from './ui/state';

export interface LinebeamApi {
  getState(): SidebarState;
}

class LinebeamController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Linebeam');
  private readonly documents = new SnapshotDocuments();
  private readonly renderer = new DiffRenderer(this.documents);
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  private readonly sidebar: WalkthroughSidebar;
  private readonly disposables: vscode.Disposable[] = [];
  private state: SessionState;
  private generation: AbortController | undefined;
  private snapshotGit: GitSnapshotService | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private freshnessTimer: NodeJS.Timeout | undefined;
  private checking: { id: string; promise: Promise<void> } | undefined;
  private readonly freshnessAbort = new AbortController();
  private navigationVersion = 0;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const savedScope = context.workspaceState.get<unknown>('scope');
    const configuredScope = vscode.workspace.getConfiguration('linebeam').get<unknown>('defaultScope', 'all');
    const scope = isChangeScope(savedScope) ? savedScope : isChangeScope(configuredScope) ? configuredScope : 'all';
    const invalidScope = !isChangeScope(configuredScope);
    if (invalidScope) {
      this.output.appendLine('Invalid linebeam.defaultScope setting. Using the displayed All local changes default.');
    }
    this.state = {
      scope,
      preferredModelName: context.globalState.get<string>('modelName', 'Choose Copilot model on first use'),
      busy: false,
      progress: '',
      error: undefined,
      notice: invalidScope ? 'The defaultScope setting is invalid. Choose a supported scope before capture.' : undefined,
      walkthrough: undefined,
      stepIndex: 0,
      screen: 'walkthrough',
      coverageFilter: 'all',
      staleReason: undefined,
      unsavedCount: 0,
      captureNote: undefined,
    };
    this.sidebar = new WalkthroughSidebar(context.extensionUri, (message) => this.receive(message), (error) => this.reportError(error));
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(WalkthroughSidebar.viewId, this.sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const snapshot = this.state.walkthrough?.snapshot;
        if (event.document.uri.scheme === 'file' && this.isWorkspaceFile(event.document.uri.fsPath)) {
          this.update({ unsavedCount: this.dirtyDocuments().length });
          if (snapshot && !snapshot.isDemo && snapshot.scope !== 'staged' && event.contentChanges.length > 0) {
            this.markStale('An editor buffer changed after capture. Highlights still refer to the read-only captured code, not your latest buffer. Regenerate to review saved changes.');
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => {
        this.update({ unsavedCount: this.dirtyDocuments().length });
        this.scheduleFreshness();
      }),
      vscode.workspace.onDidCloseTextDocument(() => this.update({ unsavedCount: this.dirtyDocuments().length })),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.generation?.abort();
        this.markStale('Workspace folders changed. Regenerate from one local repository root.');
      }),
      vscode.window.onDidChangeWindowState((windowState) => {
        if (windowState.focused) {
          this.scheduleFreshness();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (['linebeam.excludeGlobs', 'diffquill.excludeGlobs', 'diffquill.defaultScope']
          .some((setting) => event.affectsConfiguration(setting))) {
          this.generation?.abort();
          this.markStale('Capture settings changed. Check their values and regenerate to apply the current settings.');
        }
      }),
    );
    this.register('explainChanges', () => this.explain());
    this.register('chooseScope', () => this.chooseScope());
    this.register('chooseModel', () => this.chooseModel());
    this.register('previous', () => this.move(-1));
    this.register('next', () => this.move(1));
    this.register('showAllChanges', () => this.showAll());
    this.register('openWalkthrough', () => this.openWalkthrough());
    this.register('showDemo', () => this.showDemo());
    this.register('cancel', () => this.generation?.abort());
    this.register('clear', () => this.clear());
    const interval = setInterval(() => {
      if (vscode.window.state.focused) {
        this.scheduleFreshness();
      }
    }, 10_000);
    interval.unref();
    this.disposables.push(new vscode.Disposable(() => clearInterval(interval)));
    this.status.name = 'Linebeam';
    this.status.accessibilityInformation = { label: 'Linebeam walkthrough', role: 'button' };
    this.status.show();
    this.update({ unsavedCount: this.dirtyDocuments().length });
  }

  getState(): SidebarState {
    return toSidebarState(this.state);
  }

  private register(name: string, action: () => unknown | Promise<unknown>): void {
    this.disposables.push(vscode.commands.registerCommand(`linebeam.${name}`, async () => {
      try {
        await action();
      } catch (error) {
        this.reportError(error);
      }
    }));
  }

  private update(patch: Partial<SessionState>): void {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    const sidebarState = this.getState();
    this.sidebar.update(sidebarState);
    const count = this.state.walkthrough?.plan.steps.length ?? 0;
    this.status.text = this.state.busy
      ? '$(loading~spin) Linebeam'
      : count > 0
        ? `$(book) Linebeam ${this.state.stepIndex + 1}/${count}${this.state.staleReason ? ' $(warning)' : ''}`
        : this.state.walkthrough ? '$(list-tree) Linebeam Changes' : '$(sparkle) Explain Changes';
    this.status.command = this.state.busy
      ? 'linebeam.cancel'
      : count > 0 ? 'linebeam.openWalkthrough' : this.state.walkthrough ? 'linebeam.showAllChanges' : 'linebeam.explainChanges';
    this.status.backgroundColor = this.state.staleReason ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status.tooltip = this.state.busy
      ? 'Linebeam: cancel walkthrough generation'
      : `Linebeam - ${this.state.walkthrough ? 'Open the captured walkthrough' : SCOPE_DESCRIPTIONS[this.state.scope]}\nRead-only explanations, not verification.`;
    for (const [key, value] of Object.entries({
      'linebeam.hasPlan': count > 0,
      'linebeam.canGoPrevious': sidebarState.canGoPrevious,
      'linebeam.canGoNext': sidebarState.canGoNext,
    })) {
      void vscode.commands.executeCommand('setContext', key, value).then(undefined, (error: unknown) => {
        this.output.appendLine(`Could not update command context ${key}: ${errorMessage(error)}`);
      });
    }
  }

  private reportError(error: unknown): void {
    if (this.disposed || isCancelled(error)) {
      return;
    }
    const message = errorMessage(error);
    const code = error instanceof LinebeamError ? error.code : 'unexpected';
    this.output.appendLine(`[${new Date().toISOString()}] ${code}: ${message}`);
    this.update({ error: message, notice: undefined });
    void vscode.window.showErrorMessage(`Linebeam: ${message}`, 'Show Log').then((choice) => {
      if (choice === 'Show Log') {
        this.output.show(true);
      }
    }, (notificationError: unknown) => {
      this.output.appendLine(`Could not display the error notification: ${errorMessage(notificationError)}`);
    });
  }

  private requireIdle(): void {
    if (this.state.busy) {
      throw new LinebeamError('A walkthrough is being generated. Cancel it or wait before changing the review.', 'busy');
    }
  }

  private workspaceRoot(): string {
    if (!vscode.workspace.isTrusted) {
      throw new LinebeamError('Trust this workspace before using Git or a Copilot model.', 'workspace-trust');
    }
    if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop) {
      throw new LinebeamError('The MVP supports local repositories in desktop VS Code, not remote or browser workspaces.', 'unsupported-workspace');
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length !== 1 || folders[0]?.uri.scheme !== 'file') {
      throw new LinebeamError('Open exactly one local repository root as a workspace folder. Multi-root workspaces are not supported yet.', 'unsupported-workspace');
    }
    return folders[0].uri.fsPath;
  }

  private isWorkspaceFile(absolute: string): boolean {
    const roots = [
      ...(vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
      this.state.walkthrough?.snapshot.repositoryRoot,
    ];
    return roots.some((root) => root && isWithinRoot(root, absolute));
  }

  private dirtyDocuments(): readonly vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter((document) =>
      document.isDirty && document.uri.scheme === 'file' && this.isWorkspaceFile(document.uri.fsPath),
    );
  }

  private async chooseScope(): Promise<void> {
    this.requireIdle();
    const scopes: ChangeScope[] = ['all', 'staged', 'unstaged'];
    const selected = await vscode.window.showQuickPick(scopes.map((scope) => ({
      label: SCOPE_LABELS[scope],
      description: scope === this.state.scope ? 'Selected' : '',
      detail: SCOPE_DESCRIPTIONS[scope],
      scope,
    })), {
      title: 'Linebeam: Choose the next capture scope',
      placeHolder: 'Unsaved buffers and ignored untracked files are never included.',
      ignoreFocusOut: true,
    });
    if (selected) {
      await this.context.workspaceState.update('scope', selected.scope);
      this.update({ scope: selected.scope });
    }
  }

  private async rememberModel(model: vscode.LanguageModelChat): Promise<void> {
    await this.context.globalState.update('modelId', model.id);
    await this.context.globalState.update('modelName', model.name);
    this.update({ preferredModelName: model.name });
  }

  private async chooseModel(): Promise<void> {
    this.requireIdle();
    const model = await selectCopilotModel(this.context.globalState.get<string>('modelId'), true);
    if (model) {
      await this.rememberModel(model);
    }
  }

  private install(walkthrough: Walkthrough, git?: GitSnapshotService, captureNote?: string): void {
    this.navigationVersion++;
    this.renderer.clear();
    this.documents.setActive(walkthrough.snapshot);
    this.watcher?.dispose();
    this.watcher = undefined;
    this.snapshotGit = git;
    if (git) {
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(git.root), '**/*'));
      this.watcher.onDidChange(() => this.scheduleFreshness());
      this.watcher.onDidCreate(() => this.scheduleFreshness());
      this.watcher.onDidDelete(() => this.scheduleFreshness());
    }
    this.update({
      walkthrough,
      stepIndex: 0,
      screen: 'walkthrough',
      coverageFilter: 'all',
      staleReason: undefined,
      error: undefined,
      notice: undefined,
      captureNote,
    });
  }

  private assertCurrentSettings(): void {
    const legacy = vscode.workspace.getConfiguration('diffquill');
    const keys = ['defaultScope', 'excludeGlobs'].filter((key) => {
      const values = legacy.inspect<unknown>(key);
      return values && [
        values.globalValue, values.workspaceValue, values.workspaceFolderValue,
        values.globalLanguageValue, values.workspaceLanguageValue, values.workspaceFolderLanguageValue,
      ].some((value) => value !== undefined);
    });
    if (keys.length > 0) {
      const renamed = keys.map((key) => `diffquill.${key} -> linebeam.${key}`).join(', ');
      throw new LinebeamError(
        `Migrate the old DiffQuill settings before capture: ${renamed}. Preserve their values under linebeam.*, then remove the old keys. No files were captured or sent to a model.`,
        'legacy-configuration',
      );
    }
  }

  private async explain(): Promise<void> {
    this.requireIdle();
    this.assertCurrentSettings();
    const workspaceRoot = this.workspaceRoot();
    const scope = this.state.scope;
    this.navigationVersion++;
    await this.sidebar.show();
    const abort = new AbortController();
    this.generation = abort;
    this.update({ busy: true, progress: 'Capturing the selected Git scope...', error: undefined, notice: undefined });
    let capturedId: string | undefined;
    let accepted = false;
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Linebeam',
        cancellable: true,
      }, async (progress, token) => {
        const pickerCancellation = new vscode.CancellationTokenSource();
        const cancelPicker = (): void => pickerCancellation.cancel();
        abort.signal.addEventListener('abort', cancelPicker, { once: true });
        const listener = token.onCancellationRequested(() => abort.abort());
        const report = (message: string): void => {
          progress.report({ message });
          this.update({ progress: message });
        };
        try {
          const root = await discoverRepository(workspaceRoot, abort.signal);
          const dirtyCount = this.dirtyDocuments().length;
          if (dirtyCount > 0) {
            const choice = await vscode.window.showWarningMessage(
              `${dirtyCount} unsaved file(s) will not be included. Linebeam reads ${scope === 'staged' ? 'the Git index' : 'saved files'}, not editor buffers. No files will be saved automatically.`,
              { modal: true },
              'Continue Without Unsaved Edits',
            );
            checkCancelled(abort.signal);
            if (!choice) {
              throw new CancelledError();
            }
          }
          const configured = vscode.workspace.getConfiguration('linebeam').get<unknown>('excludeGlobs', []);
          if (!Array.isArray(configured) || !configured.every((entry): entry is string => typeof entry === 'string')) {
            throw new LinebeamError('linebeam.excludeGlobs must be an array of repository-relative glob strings.', 'invalid-configuration');
          }
          const git = new GitSnapshotService(root, configured);
          const snapshot = await git.capture(scope, abort.signal, report);
          checkCancelled(abort.signal);
          capturedId = snapshot.id;
          this.install({
            snapshot,
            plan: emptyPlan(snapshot, 'Captured but not yet explained.'),
            modelName: 'No model request completed',
          }, git, dirtyCount > 0 ? `${dirtyCount} unsaved file(s) were excluded at capture.` : 'Saved Git scope only. The original coding conversation is not included.');
          if (snapshot.files.length === 0) {
            this.update({ notice: 'No saved changes in this scope. No model request was made.' });
            return;
          }
          if (snapshot.files.every((file) => file.hunks.length === 0)) {
            this.update({ screen: 'changes', notice: 'There are no eligible text hunks to explain. All Changes lists the metadata and unsupported content. No model request was made.' });
            return;
          }
          report('Selecting an available Copilot model...');
          const model = await selectCopilotModel(this.context.globalState.get<string>('modelId'), false, pickerCancellation.token);
          checkCancelled(abort.signal);
          if (!model) {
            throw new CancelledError();
          }
          await this.rememberModel(model);
          const result = await explainWithCopilot(snapshot, model, abort.signal, report);
          checkCancelled(abort.signal);
          accepted = true;
          this.update({
            walkthrough: { snapshot, plan: result.plan, modelName: model.name },
            screen: result.plan.steps.length > 0 ? 'walkthrough' : 'changes',
            notice: result.plan.steps.length > 0 ? undefined : 'The model returned no explanation steps. Its skips and any missing coverage are listed in All Changes.',
          });
          await this.checkFreshness();
          checkCancelled(abort.signal);
          if (result.plan.steps.length > 0) {
            await this.showStep(0);
          }
        } finally {
          listener.dispose();
          abort.signal.removeEventListener('abort', cancelPicker);
          pickerCancellation.dispose();
        }
      });
    } catch (error) {
      const cancelled = abort.signal.aborted || isCancelled(error);
      const walkthrough = this.state.walkthrough;
      if (!accepted && capturedId && walkthrough?.snapshot.id === capturedId) {
        this.update({
          walkthrough: {
            ...walkthrough,
            plan: emptyPlan(walkthrough.snapshot, cancelled ? 'Generation was cancelled; this hunk was not explained.' : 'Generation failed; this hunk was not explained.'),
          },
          screen: 'changes',
        });
      }
      if (cancelled) {
        this.update({ notice: 'Generation cancelled. Any captured changes remain available for manual inspection. No additional request will be made automatically.' });
      } else {
        this.reportError(error);
      }
    } finally {
      if (this.generation === abort) {
        this.generation = undefined;
      }
      this.update({ busy: false, progress: '', unsavedCount: this.dirtyDocuments().length });
    }
  }

  private async showStep(index: number, referenceIndex = 0): Promise<void> {
    const walkthrough = this.state.walkthrough;
    const step = walkthrough?.plan.steps[index];
    const reference = step?.references[referenceIndex];
    const file = walkthrough?.snapshot.files.find((entry) => entry.id === reference?.fileId);
    if (!walkthrough || !step || !reference || !file) {
      throw new LinebeamError('That step or reference is not part of the active walkthrough.', 'invalid-reference');
    }
    const version = ++this.navigationVersion;
    this.update({ stepIndex: index, screen: 'walkthrough', coverageFilter: 'all' });
    await this.checkFreshness();
    if (version !== this.navigationVersion || this.state.walkthrough?.snapshot.id !== walkthrough.snapshot.id) {
      return;
    }
    const note = `${step.title}\n\n${step.explanation}\n\nWhy it matters: ${step.significance}${step.question ? `\n\nReview question: ${step.question}` : ''}\n\nCaptured code only. This explanation is not verification.`;
    await this.renderer.open(walkthrough.snapshot, file, step.references, note);
  }

  private async move(offset: number): Promise<void> {
    this.requireIdle();
    const count = this.state.walkthrough?.plan.steps.length ?? 0;
    if (count === 0) {
      await this.sidebar.show();
      this.update({ notice: 'Generate a walkthrough or try the offline demo before navigating steps.' });
      return;
    }
    const next = this.state.stepIndex + offset;
    if (next >= 0 && next < count) {
      await this.showStep(next);
    }
  }

  private async openWalkthrough(): Promise<void> {
    this.requireIdle();
    const version = ++this.navigationVersion;
    this.update({ screen: 'walkthrough', coverageFilter: 'all' });
    await this.sidebar.show();
    if (version !== this.navigationVersion) {
      return;
    }
    if (this.state.walkthrough?.plan.steps.length) {
      await this.showStep(this.state.stepIndex);
    }
  }

  private async showAll(filter: CoverageFilter = 'all'): Promise<void> {
    this.requireIdle();
    const version = ++this.navigationVersion;
    await this.checkFreshness();
    if (version !== this.navigationVersion) {
      return;
    }
    this.update({ screen: 'changes', coverageFilter: filter });
    await this.sidebar.show();
  }

  private async showDemo(): Promise<void> {
    this.requireIdle();
    this.install(createDemo(), undefined, 'Offline fixture. No workspace files were read or changed; no model was called.');
    const version = this.navigationVersion;
    await this.sidebar.show();
    if (version === this.navigationVersion) {
      await this.showStep(0);
    }
  }

  private clear(): void {
    this.requireIdle();
    this.navigationVersion++;
    this.renderer.clear();
    this.documents.setActive(undefined);
    this.watcher?.dispose();
    this.watcher = undefined;
    this.snapshotGit = undefined;
    this.update({
      walkthrough: undefined, stepIndex: 0, screen: 'walkthrough', staleReason: undefined,
      error: undefined, notice: undefined, captureNote: undefined, coverageFilter: 'all',
    });
  }

  private assertSnapshot(snapshotId: string): ReviewSnapshot {
    const snapshot = this.state.walkthrough?.snapshot;
    if (!snapshot || snapshot.id !== snapshotId) {
      throw new LinebeamError('This sidebar action belongs to an older snapshot. Use the current walkthrough.', 'stale-ui');
    }
    return snapshot;
  }

  private async receive(value: unknown): Promise<void> {
    const message = parseSidebarMessage(value);
    if (!message) {
      throw new LinebeamError('An unsupported sidebar action was rejected.', 'invalid-ui-message');
    }
    if (message.type === 'ready') {
      this.sidebar.update(this.getState());
      return;
    }
    if (message.type === 'action') {
      const actions: Record<typeof message.action, () => unknown> = {
        explain: () => this.explain(),
        scope: () => this.chooseScope(),
        model: () => this.chooseModel(),
        previous: () => this.move(-1),
        next: () => this.move(1),
        all: () => this.showAll(),
        walkthrough: () => this.openWalkthrough(),
        demo: () => this.showDemo(),
        cancel: () => this.generation?.abort(),
        clear: () => this.clear(),
      };
      await actions[message.action]();
      return;
    }
    this.requireIdle();
    const snapshot = this.assertSnapshot(message.snapshotId);
    if (message.type === 'coverage') {
      await this.showAll(message.filter);
      return;
    }
    if (message.type === 'step') {
      await this.showStep(message.index);
    } else if (message.type === 'reference') {
      const step = this.state.walkthrough?.plan.steps[this.state.stepIndex];
      if (!step || step.id !== message.stepId) {
        throw new LinebeamError('This reference belongs to a different step. Use the visible evidence links.', 'stale-ui');
      }
      await this.showStep(this.state.stepIndex, message.index);
    } else {
      const file = snapshot.files.find((entry) => entry.id === message.fileId);
      const hunk = file?.hunks.find((entry) => entry.id === message.hunkId);
      if (!file || (message.hunkId && !hunk)) {
        throw new LinebeamError('That file or hunk is not in this snapshot.', 'invalid-reference');
      }
      const references: SourceReference[] = hunk ? [
        ...(hunk.oldRanges.length > 0 ? [{ fileId: file.id, hunkId: hunk.id, side: 'old' as const, ranges: hunk.oldRanges }] : []),
        ...(hunk.newRanges.length > 0 ? [{ fileId: file.id, hunkId: hunk.id, side: 'new' as const, ranges: hunk.newRanges }] : []),
      ] : [];
      const version = ++this.navigationVersion;
      await this.checkFreshness();
      if (version !== this.navigationVersion || this.state.walkthrough?.snapshot.id !== snapshot.id) {
        return;
      }
      await this.renderer.open(snapshot, file, references);
    }
  }

  private markStale(reason: string): void {
    if (this.state.walkthrough && !this.state.walkthrough.snapshot.isDemo && !this.state.staleReason) {
      this.update({ staleReason: reason });
    }
  }

  private scheduleFreshness(): void {
    if (!this.state.walkthrough || this.state.walkthrough.snapshot.isDemo || this.state.busy || this.state.staleReason || this.disposed) {
      return;
    }
    if (this.freshnessTimer) {
      clearTimeout(this.freshnessTimer);
    }
    this.freshnessTimer = setTimeout(() => {
      this.freshnessTimer = undefined;
      void this.checkFreshness();
    }, 400);
  }

  private async checkFreshness(): Promise<void> {
    const snapshot = this.state.walkthrough?.snapshot;
    const git = this.snapshotGit;
    if (!snapshot || snapshot.isDemo || !git || this.state.staleReason || this.disposed) {
      return;
    }
    if (this.checking) {
      if (this.checking.id === snapshot.id) {
        return this.checking.promise;
      }
      await this.checking.promise;
      return this.checkFreshness();
    }
    const promise = (async (): Promise<void> => {
      try {
        const changed = await git.hasChanged(snapshot, this.freshnessAbort.signal);
        if (!this.disposed && changed && this.state.walkthrough?.snapshot.id === snapshot.id) {
          this.markStale('The saved comparison or Git baseline has changed. The diff and highlights remain bound to the earlier capture. Regenerate when you want the latest changes.');
        }
      } catch (error) {
        if (!this.disposed && this.state.walkthrough?.snapshot.id === snapshot.id) {
          this.output.appendLine(`Freshness check failed: ${errorMessage(error)}`);
          this.markStale('Freshness could not be verified. This is still the captured code, not a live diff. Regenerate to check the current scope.');
        }
      } finally {
        this.checking = undefined;
      }
    })();
    this.checking = { id: snapshot.id, promise };
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.navigationVersion++;
    this.generation?.abort();
    this.freshnessAbort.abort();
    if (this.freshnessTimer) {
      clearTimeout(this.freshnessTimer);
    }
    this.watcher?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.renderer.dispose();
    this.documents.dispose();
    this.status.dispose();
    this.output.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): LinebeamApi {
  const controller = new LinebeamController(context);
  context.subscriptions.push(controller);
  return { getState: () => controller.getState() };
}
