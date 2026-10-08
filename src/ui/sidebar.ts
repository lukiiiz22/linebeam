import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { SidebarState } from './state';

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class WalkthroughSidebar implements vscode.WebviewViewProvider {
  static readonly viewId = 'linebeam.walkthrough';
  private view: vscode.WebviewView | undefined;
  private state: SidebarState | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly receive: (value: unknown) => Promise<void>,
    private readonly reportError: (error: unknown) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [media],
    };
    const nonce = randomBytes(24).toString('base64');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    view.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attribute(view.webview.cspSource)}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <link rel="stylesheet" href="${attribute(style.toString())}">
  <title>Linebeam walkthrough</title>
</head>
<body>
  <main id="app" aria-label="Linebeam guided diff walkthrough"></main>
  <script nonce="${nonce}" src="${attribute(script.toString())}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((value: unknown) => {
      void this.receive(value).catch(this.reportError);
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    if (this.state) {
      this.update(this.state);
    }
  }

  update(state: SidebarState): void {
    this.state = state;
    if (this.view) {
      void this.view.webview.postMessage(state).then(undefined, this.reportError);
    }
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${WalkthroughSidebar.viewId}.focus`);
  }
}
