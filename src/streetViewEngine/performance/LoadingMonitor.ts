import type { BufferMonitorSnapshot, BufferReadiness, BufferSlotId } from '../types';

/**
 * Tracks double-buffer readiness, preparation timing, and atomic 0ms swap counts
 * without ever blocking user controls or rendering.
 */
export class LoadingMonitor {
  private displayedBuffer: BufferSlotId = 'A';
  private displayedPanoId: string | null = null;
  private stagingBuffer: BufferSlotId = 'B';
  private stagingPanoId: string | null = null;
  private stagingStatus: BufferReadiness = 'empty';
  private prepareStartedAtMs = 0;
  private lastPrepareMs = 0;
  private swapCount = 0;

  public markPreparing(stagingBuffer: BufferSlotId, panoId: string): void {
    this.stagingBuffer = stagingBuffer;
    this.stagingPanoId = panoId;
    this.stagingStatus = 'preparing';
    this.prepareStartedAtMs =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  public markReady(stagingBuffer: BufferSlotId, panoId: string): void {
    if (this.stagingBuffer === stagingBuffer && this.stagingPanoId === panoId) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.lastPrepareMs = Math.max(0, Math.round(now - this.prepareStartedAtMs));
      this.stagingStatus = 'ready';
    }
  }

  public markSwapped(
    newDisplayedBuffer: BufferSlotId,
    newDisplayedPanoId: string,
    newStagingBuffer: BufferSlotId,
  ): void {
    this.displayedBuffer = newDisplayedBuffer;
    this.displayedPanoId = newDisplayedPanoId;
    this.stagingBuffer = newStagingBuffer;
    this.stagingPanoId = null;
    this.stagingStatus = 'empty';
    this.swapCount += 1;
  }

  public markInitialDisplay(displayedBuffer: BufferSlotId, panoId: string): void {
    this.displayedBuffer = displayedBuffer;
    this.displayedPanoId = panoId;
    this.stagingBuffer = displayedBuffer === 'A' ? 'B' : 'A';
    this.stagingPanoId = null;
    this.stagingStatus = 'empty';
  }

  public getSnapshot(): BufferMonitorSnapshot {
    return {
      displayedBuffer: this.displayedBuffer,
      displayedPanoId: this.displayedPanoId,
      stagingBuffer: this.stagingBuffer,
      stagingPanoId: this.stagingPanoId,
      stagingStatus: this.stagingStatus,
      swapCount: this.swapCount,
      lastPrepareMs: this.lastPrepareMs,
      transitionDurationMs: 0,
    };
  }
}
