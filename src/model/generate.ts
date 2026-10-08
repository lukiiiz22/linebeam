import { checkCancelled, LinebeamError } from '../core/errors';
import { validatePlanResponse } from '../core/plan';
import { preparePrompt, type TokenCounter } from '../core/prompt';
import { LIMITS, type PreparedPrompt, type ReviewPlan, type ReviewSnapshot } from '../core/types';

export interface TextModel extends TokenCounter {
  sendRequest(prompt: string): Promise<AsyncIterable<string>>;
}

export interface GenerationResult {
  readonly plan: ReviewPlan;
  readonly prompt: PreparedPrompt;
}

export async function generateWalkthrough(
  snapshot: ReviewSnapshot,
  model: TextModel,
  signal?: AbortSignal,
  report: (message: string) => void = () => {},
): Promise<GenerationResult> {
  report('Preparing bounded change context...');
  const prompt = await preparePrompt(snapshot, model, signal);
  checkCancelled(signal);
  report(`Explaining ${prompt.includedHunkIds.size} captured hunks in one model request...`);
  const stream = await model.sendRequest(prompt.text);
  let response = '';
  for await (const fragment of stream) {
    checkCancelled(signal);
    response += fragment;
    if (response.length > LIMITS.responseCharacters) {
      throw new LinebeamError('The model response exceeded the size limit. Nothing was accepted; use a narrower scope and retry.', 'response-limit');
    }
  }
  checkCancelled(signal);
  report('Validating snapshot-bound references...');
  return {
    plan: validatePlanResponse(response, snapshot, prompt.includedHunkIds, prompt.omitted),
    prompt,
  };
}
