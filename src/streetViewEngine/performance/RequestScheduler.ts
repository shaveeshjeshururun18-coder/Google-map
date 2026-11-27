import type { ProviderPolicy } from '../types';

/**
 * Policy-aware abortable request scheduler.
 * Deduplicates in-flight fetches, cancels obsolete preparation tasks when the
 * driver steers to a new link, and strictly enforces provider preloading rules.
 */
export class RequestScheduler {
  private readonly policy: ProviderPolicy;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(policy: ProviderPolicy) {
    this.policy = policy;
  }

  public canPrepareNext(): boolean {
    return this.policy.allowSingleNextPrepare;
  }

  public canMultiHopPreload(): boolean {
    return this.policy.allowMultiHopPreload;
  }

  /**
   * Runs an abortable keyed task with single-flight deduplication.
   */
  public schedule<T>(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const controller = new AbortController();
    this.activeControllers.set(key, controller);

    const promise = task(controller.signal).finally(() => {
      if (this.activeControllers.get(key) === controller) {
        this.activeControllers.delete(key);
      }
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  public cancel(key: string): void {
    const controller = this.activeControllers.get(key);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(key);
    }
    this.inFlight.delete(key);
  }

  public cancelAllExcept(keepKey?: string): void {
    for (const [key, controller] of this.activeControllers.entries()) {
      if (key !== keepKey) {
        controller.abort();
        this.activeControllers.delete(key);
        this.inFlight.delete(key);
      }
    }
  }

  public dispose(): void {
    this.cancelAllExcept();
  }
}
