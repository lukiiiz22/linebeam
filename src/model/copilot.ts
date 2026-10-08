import * as vscode from 'vscode';
import { checkCancelled, LinebeamError, isCancelled } from '../core/errors';
import type { ReviewSnapshot } from '../core/types';
import { generateWalkthrough, type GenerationResult } from './generate';

export function modelError(error: unknown): Error {
  if (error instanceof vscode.LanguageModelError) {
    const detail = error.message ? ` Provider: ${error.message}` : '';
    if (error.code === vscode.LanguageModelError.NoPermissions.name) {
      return new LinebeamError(`Copilot access was not granted. Check the VS Code consent prompt, sign-in, and your organization's model policy.${detail}`, 'model-permission');
    }
    if (error.code === vscode.LanguageModelError.NotFound.name) {
      return new LinebeamError(`The selected Copilot model is no longer available. Use Choose Copilot Model and retry.${detail}`, 'model-unavailable');
    }
    if (error.code === vscode.LanguageModelError.Blocked.name) {
      return new LinebeamError(`Copilot blocked this request. Quota, rate limits, or organization restrictions may apply. Linebeam will not retry automatically.${detail}`, 'model-blocked');
    }
    return new LinebeamError(`The Copilot request failed (${error.code}). No walkthrough was accepted.${detail}`, 'model-failed');
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function selectCopilotModel(
  preferredId: string | undefined,
  forcePicker: boolean,
  token?: vscode.CancellationToken,
): Promise<vscode.LanguageModelChat | undefined> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (token?.isCancellationRequested) {
      return undefined;
    }
    if (models.length === 0) {
      throw new LinebeamError('No Copilot models are available. Sign in to GitHub Copilot in desktop VS Code and check your access or organization policy. The offline demo does not need a model.', 'model-unavailable');
    }
    const preferred = models.find((model) => model.id === preferredId);
    if (preferred && !forcePicker) {
      return preferred;
    }
    const choices = models.map((model) => ({
      label: model.name,
      description: model.id === preferredId ? 'Previously selected' : model.family,
      detail: `${model.maxInputTokens.toLocaleString()} input tokens - Copilot usage and limits apply`,
      model,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Linebeam: Choose a Copilot model',
      placeHolder: preferredId && !preferred
        ? 'Your previous model is unavailable. Choose an available model.'
        : 'A new request will include captured diff hunks, not the original coding conversation.',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    }, token);
    return selected?.model;
  } catch (error) {
    throw modelError(error);
  }
}

export async function explainWithCopilot(
  snapshot: ReviewSnapshot,
  model: vscode.LanguageModelChat,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<GenerationResult> {
  checkCancelled(signal);
  const cancellation = new vscode.CancellationTokenSource();
  const cancel = (): void => cancellation.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await generateWalkthrough(snapshot, {
      maxInputTokens: model.maxInputTokens,
      countTokens: async (text) => model.countTokens(vscode.LanguageModelChatMessage.User(text), cancellation.token),
      sendRequest: async (prompt) => {
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {
          justification: 'Explain the explicitly scoped Git changes in Linebeam using a read-only guided diff walkthrough.',
        }, cancellation.token);
        return response.text;
      },
    }, signal, report);
  } catch (error) {
    cancellation.cancel();
    if (signal.aborted || isCancelled(error)) {
      checkCancelled(signal);
      throw error;
    }
    throw modelError(error);
  } finally {
    signal.removeEventListener('abort', cancel);
    cancellation.dispose();
  }
}
