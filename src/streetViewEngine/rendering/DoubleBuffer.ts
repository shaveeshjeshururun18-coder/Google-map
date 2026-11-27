import type { BufferReadiness, BufferSlotId, PanoramaMetadata } from '../types';

export interface BufferSlot<T> {
  readonly id: BufferSlotId;
  panoId: string | null;
  metadata: PanoramaMetadata | null;
  payload: T | null;
  status: BufferReadiness;
  preparedAtMs: number;
}

export interface SwapResult<T> {
  swapped: boolean;
  displayed: BufferSlot<T>;
  staging: BufferSlot<T>;
  evictedPayload: T | null;
}

/**
 * Pure Double-Buffer (Buffer A / Buffer B) state machine for zero-flash panorama rendering.
 *
 * Invariant:
 * - The displayed buffer remains 100% visible and immutable while the staging buffer prepares
 *   the next panorama.
 * - `commitSwap(expectedPanoId)` ONLY swaps when the staging buffer is `'ready'` for that exact
 *   panorama ID, guaranteeing zero loading flashes and 0ms atomic replacement.
 */
export class DoubleBuffer<T> {
  private readonly slots: Record<BufferSlotId, BufferSlot<T>>;
  private displayedId: BufferSlotId = 'A';
  private swapCount = 0;

  constructor() {
    this.slots = {
      A: {
        id: 'A',
        panoId: null,
        metadata: null,
        payload: null,
        status: 'empty',
        preparedAtMs: 0,
      },
      B: {
        id: 'B',
        panoId: null,
        metadata: null,
        payload: null,
        status: 'empty',
        preparedAtMs: 0,
      },
    };
  }

  public getDisplayed(): BufferSlot<T> {
    return this.slots[this.displayedId];
  }

  public getStaging(): BufferSlot<T> {
    return this.slots[this.displayedId === 'A' ? 'B' : 'A'];
  }

  public getSwapCount(): number {
    return this.swapCount;
  }

  /**
   * Commits the very first panorama directly into Buffer A (displayed).
   */
  public setInitialDisplayed(metadata: PanoramaMetadata, payload: T): BufferSlot<T> {
    const slot = this.getDisplayed();
    slot.panoId = metadata.panoId;
    slot.metadata = metadata;
    slot.payload = payload;
    slot.status = 'ready';
    slot.preparedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return slot;
  }

  /**
   * Marks standby staging buffer as preparing a specific next panorama ID.
   * Never touches the currently displayed buffer.
   */
  public beginPrepare(panoId: string): BufferSlot<T> {
    const staging = this.getStaging();
    if (staging.panoId === panoId && staging.status === 'ready') {
      return staging;
    }
    staging.panoId = panoId;
    staging.metadata = null;
    staging.payload = null;
    staging.status = 'preparing';
    staging.preparedAtMs = 0;
    return staging;
  }

  /**
   * Marks staging buffer ready once its full image/tiles are decoded.
   * Ignores stale completions if steering already requested a different panoId.
   */
  public markStagingReady(metadata: PanoramaMetadata, payload: T): boolean {
    const staging = this.getStaging();
    if (staging.panoId !== metadata.panoId) {
      return false;
    }
    staging.metadata = metadata;
    staging.payload = payload;
    staging.status = 'ready';
    staging.preparedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return true;
  }

  public isStagingReadyFor(panoId: string): boolean {
    const staging = this.getStaging();
    return (
      staging.status === 'ready' &&
      staging.panoId === panoId &&
      staging.payload !== null
    );
  }

  /**
   * Atomic 0ms swap: promotes the ready staging buffer to displayed in one operation.
   * Returns `swapped: false` if staging is not completely ready (prevents loading flashes).
   */
  public commitSwap(expectedPanoId?: string): SwapResult<T> {
    const staging = this.getStaging();
    const matches =
      expectedPanoId === undefined ? staging.panoId !== null : staging.panoId === expectedPanoId;

    if (staging.status !== 'ready' || !matches || staging.payload === null) {
      return {
        swapped: false,
        displayed: this.getDisplayed(),
        staging,
        evictedPayload: null,
      };
    }

    const previousDisplayed = this.getDisplayed();
    const evictedPayload = previousDisplayed.payload;

    // Atomic flip: staging becomes displayed, previous displayed becomes clean staging
    this.displayedId = staging.id;
    this.swapCount += 1;

    previousDisplayed.panoId = null;
    previousDisplayed.metadata = null;
    previousDisplayed.payload = null;
    previousDisplayed.status = 'empty';
    previousDisplayed.preparedAtMs = 0;

    return {
      swapped: true,
      displayed: this.getDisplayed(),
      staging: this.getStaging(),
      evictedPayload,
    };
  }

  public reset(): { displayedPayload: T | null; stagingPayload: T | null } {
    const displayedPayload = this.getDisplayed().payload;
    const stagingPayload = this.getStaging().payload;

    for (const id of ['A', 'B'] as const) {
      this.slots[id].panoId = null;
      this.slots[id].metadata = null;
      this.slots[id].payload = null;
      this.slots[id].status = 'empty';
      this.slots[id].preparedAtMs = 0;
    }
    this.displayedId = 'A';
    return { displayedPayload, stagingPayload };
  }
}
