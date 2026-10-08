export class LinebeamError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'LinebeamError';
  }
}

export class CancelledError extends LinebeamError {
  constructor() {
    super('Walkthrough generation was cancelled.', 'cancelled');
  }
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CancelledError();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled'));
}
