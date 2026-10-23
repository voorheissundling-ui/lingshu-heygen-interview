export interface LinkedAbortHandle {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  abort(reason?: unknown): void;
  cleanup(): void;
}

/**
 * Creates a cancellable deadline that also follows an optional parent signal.
 * Keeping the timer and listener cleanup in one place prevents timed-out LLM
 * requests from continuing to occupy sockets after their caller has moved on.
 */
export function createLinkedAbort(options: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  label?: string;
}): LinkedAbortHandle {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  let timedOut = false;

  const abortFromParent = () => {
    controller.abort(options.parentSignal?.reason ?? new Error(`${options.label || 'operation'} cancelled`));
  };

  if (options.parentSignal?.aborted) abortFromParent();
  else options.parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${options.label || 'operation'} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    abort(reason?: unknown) {
      controller.abort(reason ?? new Error(`${options.label || 'operation'} cancelled`));
    },
    cleanup() {
      clearTimeout(timer);
      options.parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}
