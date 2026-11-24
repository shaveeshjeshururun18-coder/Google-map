import type {
  PanoramaMetadata,
  QualityPreset,
  TransitionState,
} from '../types/streetview';

export interface PanoramaAsset {
  metadata: PanoramaMetadata;
  canvas: HTMLCanvasElement;
  zoom: number;
}

export interface TransitionAssetLoader {
  fetchMetadataByPanoId(panoId: string, signal: AbortSignal): Promise<PanoramaMetadata>;
  fetchMetadataByLocation(
    lat: number,
    lng: number,
    radius: number,
    signal: AbortSignal,
  ): Promise<PanoramaMetadata>;
  loadPanoramaCanvas(
    metadata: PanoramaMetadata,
    quality: QualityPreset,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number, canvas: HTMLCanvasElement) => void,
  ): Promise<{ canvas: HTMLCanvasElement; zoom: number }>;
}

export interface TransitionCallbacks {
  onStateChange?: (state: TransitionState) => void;
  onProgressiveUpdate?: (metadata: PanoramaMetadata, canvas: HTMLCanvasElement) => void;
  onBlendFrame?: (
    outgoing: PanoramaMetadata | null,
    incoming: PanoramaAsset,
    blendProgress: number,
  ) => void;
  onComplete?: (asset: PanoramaAsset) => void;
}

const DEFAULT_BLEND_DURATION_MS = 85;
const MAX_PRELOAD_CACHE = 8;

export class PanoramaTransitionManager {
  private readonly loader: TransitionAssetLoader;
  private readonly callbacks: TransitionCallbacks;
  private readonly blendDurationMs: number;

  private activeController: AbortController | null = null;
  private activeRequestSeq = 0;
  private activeMetadata: PanoramaMetadata | null = null;
  private preloadedAssets = new Map<string, PanoramaAsset>();
  private preloadControllers = new Map<string, AbortController>();

  private state: TransitionState = {
    isTransitioning: false,
    fromPanoId: null,
    toPanoId: null,
    blendProgress: 0,
    tilesLoaded: 0,
    tilesTotal: 0,
    phase: 'idle',
    message: '',
  };

  constructor(
    loader: TransitionAssetLoader,
    callbacks: TransitionCallbacks = {},
    blendDurationMs = DEFAULT_BLEND_DURATION_MS,
  ) {
    this.loader = loader;
    this.callbacks = callbacks;
    this.blendDurationMs = blendDurationMs;
  }

  public getState(): TransitionState {
    return { ...this.state };
  }

  public getActiveMetadata(): PanoramaMetadata | null {
    return this.activeMetadata;
  }

  public setActiveMetadata(metadata: PanoramaMetadata): void {
    this.activeMetadata = metadata;
  }

  private emitState(patch: Partial<TransitionState>): void {
    this.state = { ...this.state, ...patch };
    this.callbacks.onStateChange?.(this.getState());
  }

  public cancelActiveTransition(): void {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    this.activeRequestSeq += 1;
    if (this.state.isTransitioning) {
      this.emitState({
        isTransitioning: false,
        phase: 'idle',
        blendProgress: 0,
        message: '',
      });
    }
  }

  public clearPreloads(): void {
    for (const controller of this.preloadControllers.values()) {
      controller.abort();
    }
    this.preloadControllers.clear();
    this.preloadedAssets.clear();
  }

  public async preloadByPanoId(
    panoId: string,
    quality: QualityPreset,
  ): Promise<void> {
    if (
      this.preloadedAssets.has(panoId) ||
      this.preloadControllers.has(panoId) ||
      this.activeMetadata?.panoId === panoId
    ) {
      return;
    }

    const controller = new AbortController();
    this.preloadControllers.set(panoId, controller);

    try {
      const metadata = await this.loader.fetchMetadataByPanoId(panoId, controller.signal);
      if (controller.signal.aborted) return;

      const { canvas, zoom } = await this.loader.loadPanoramaCanvas(
        metadata,
        quality,
        controller.signal,
        () => {},
      );
      if (controller.signal.aborted) return;

      this.storePreload({ metadata, canvas, zoom });
    } catch {
      // Preload failures are non-fatal; live transition handles errors explicitly
    } finally {
      this.preloadControllers.delete(panoId);
    }
  }

  private storePreload(asset: PanoramaAsset): void {
    if (this.preloadedAssets.has(asset.metadata.panoId)) {
      this.preloadedAssets.delete(asset.metadata.panoId);
    }
    this.preloadedAssets.set(asset.metadata.panoId, asset);
    if (this.preloadedAssets.size > MAX_PRELOAD_CACHE) {
      const oldest = this.preloadedAssets.keys().next().value;
      if (oldest) {
        this.preloadedAssets.delete(oldest);
      }
    }
  }

  public async transitionToLocation(
    lat: number,
    lng: number,
    quality: QualityPreset,
    radius = 50,
  ): Promise<PanoramaAsset | null> {
    return this.executeTransition(
      null,
      quality,
      (signal) => this.loader.fetchMetadataByLocation(lat, lng, radius, signal),
    );
  }

  public async transitionToPanoId(
    panoId: string,
    quality: QualityPreset,
  ): Promise<PanoramaAsset | null> {
    return this.executeTransition(
      panoId,
      quality,
      (signal) => this.loader.fetchMetadataByPanoId(panoId, signal),
    );
  }

  private async executeTransition(
    targetPanoId: string | null,
    quality: QualityPreset,
    resolveMetadata: (signal: AbortSignal) => Promise<PanoramaMetadata>,
  ): Promise<PanoramaAsset | null> {
    // Cancel any obsolete in-flight transition so overlapping requests never collide
    if (this.activeController) {
      this.activeController.abort();
    }

    const controller = new AbortController();
    this.activeController = controller;
    const seq = ++this.activeRequestSeq;
    const fromPanoId = this.activeMetadata?.panoId ?? null;

    // Fast path: already preloaded!
    if (targetPanoId && this.preloadedAssets.has(targetPanoId)) {
      const preloaded = this.preloadedAssets.get(targetPanoId)!;
      this.preloadedAssets.delete(targetPanoId);

      this.emitState({
        isTransitioning: true,
        fromPanoId,
        toPanoId: targetPanoId,
        blendProgress: 0,
        tilesLoaded: 1,
        tilesTotal: 1,
        phase: 'blending',
        message: `Entering ${preloaded.metadata.streetName}`,
      });

      const finished = await this.runBlendAnimation(preloaded, seq, controller.signal);
      if (!finished) return null;

      this.activeMetadata = preloaded.metadata;
      this.emitState({
        isTransitioning: false,
        fromPanoId: preloaded.metadata.panoId,
        toPanoId: preloaded.metadata.panoId,
        blendProgress: 1,
        phase: 'idle',
        message: '',
      });
      this.callbacks.onComplete?.(preloaded);
      return preloaded;
    }

    this.emitState({
      isTransitioning: true,
      fromPanoId,
      toPanoId: targetPanoId,
      blendProgress: 0,
      tilesLoaded: 0,
      tilesTotal: 0,
      phase: 'fetching-metadata',
      message: 'Checking Street View coverage...',
    });

    try {
      const metadata = await resolveMetadata(controller.signal);
      if (seq !== this.activeRequestSeq || controller.signal.aborted) {
        return null;
      }

      this.emitState({
        toPanoId: metadata.panoId,
        phase: 'loading-tiles',
        message: `Loading ${metadata.streetName}...`,
      });

      let previewShown = false;
      const { canvas, zoom } = await this.loader.loadPanoramaCanvas(
        metadata,
        quality,
        controller.signal,
        (loaded, total, progressiveCanvas) => {
          if (seq !== this.activeRequestSeq || controller.signal.aborted) return;
          this.emitState({
            tilesLoaded: loaded,
            tilesTotal: total,
            phase: 'loading-tiles',
          });
          // Once first tile arrives and we don't yet have an active panorama, display progressively
          if (!this.activeMetadata && !previewShown) {
            previewShown = true;
            this.callbacks.onProgressiveUpdate?.(metadata, progressiveCanvas);
          } else if (previewShown) {
            this.callbacks.onProgressiveUpdate?.(metadata, progressiveCanvas);
          }
        },
      );

      if (seq !== this.activeRequestSeq || controller.signal.aborted) {
        return null;
      }

      const asset: PanoramaAsset = { metadata, canvas, zoom };

      this.emitState({
        phase: 'blending',
        blendProgress: 0,
        message: `Entering ${metadata.streetName}`,
      });

      const finished = await this.runBlendAnimation(asset, seq, controller.signal);
      if (!finished) return null;

      this.activeMetadata = metadata;
      this.emitState({
        isTransitioning: false,
        fromPanoId: metadata.panoId,
        toPanoId: metadata.panoId,
        blendProgress: 1,
        phase: 'idle',
        message: '',
      });

      this.callbacks.onComplete?.(asset);
      return asset;
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === 'AbortError') ||
        seq !== this.activeRequestSeq
      ) {
        return null;
      }

      // Recover gracefully: keep previous panorama visible and expose error state
      this.emitState({
        isTransitioning: false,
        blendProgress: 0,
        phase: 'error',
        message: err instanceof Error ? err.message : 'Transition failed.',
      });
      throw err;
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  private async runBlendAnimation(
    incoming: PanoramaAsset,
    seq: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.activeMetadata || this.blendDurationMs <= 0) {
      this.callbacks.onBlendFrame?.(this.activeMetadata, incoming, 1);
      return !signal.aborted && seq === this.activeRequestSeq;
    }

    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const outgoing = this.activeMetadata;

    return new Promise<boolean>((resolve) => {
      const step = () => {
        if (signal.aborted || seq !== this.activeRequestSeq) {
          resolve(false);
          return;
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const rawT = Math.min(1, (now - startTime) / this.blendDurationMs);
        // Smooth ease-out cubic curve
        const eased = 1 - Math.pow(1 - rawT, 3);
        this.callbacks.onBlendFrame?.(outgoing, incoming, eased);
        this.emitState({ blendProgress: eased });

        if (rawT >= 1) {
          resolve(true);
          return;
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(step);
        } else {
          setTimeout(step, 16);
        }
      };

      step();
    });
  }

  public dispose(): void {
    this.cancelActiveTransition();
    this.clearPreloads();
  }
}
