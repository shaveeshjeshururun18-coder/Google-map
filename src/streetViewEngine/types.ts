import type {
  NavigationHistoryEntry,
  PanoramaMetadata,
  PlaceResult,
  PlaceSuggestion,
  QualityPreset,
  RelativeDirection,
  SimulatorError,
  StreetViewLink,
} from '../types/streetview';

export type {
  NavigationHistoryEntry,
  PanoramaMetadata,
  PlaceResult,
  PlaceSuggestion,
  QualityPreset,
  RelativeDirection,
  SimulatorError,
  StreetViewLink,
};

export type GearMode = 'D' | 'R' | 'N';
export type BufferSlotId = 'A' | 'B';
export type BufferReadiness = 'empty' | 'preparing' | 'ready';

export interface ProviderPolicy {
  /** True only for providers whose license allows fetching multiple hops ahead. */
  allowMultiHopPreload: boolean;
  /** True only for providers whose license allows caching imagery beyond active playback. */
  allowPersistentImageCache: boolean;
  /** True when the immediate next viewpoint may be prepared in standby Buffer B. */
  allowSingleNextPrepare: boolean;
  attributionLabel: string;
}

export interface DecodedPanoramaFrame {
  metadata: PanoramaMetadata;
  canvas: HTMLCanvasElement;
  zoom: number;
}

/**
 * Provider-independent interface allowing Google Street View (primary) or any
 * independently licensed 360° panorama dataset to drive the exact same
 * navigation, double-buffer, and instant-swap engine.
 */
export interface PanoramaProvider {
  readonly id: string;
  readonly name: string;
  readonly policy: ProviderPolicy;

  fetchMetadataByLocation(
    lat: number,
    lng: number,
    radius?: number,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata>;

  fetchMetadataById(
    panoId: string,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata>;

  decodePanoramaFrame?(
    metadata: PanoramaMetadata,
    quality: QualityPreset,
    maxTextureWidth: number,
    signal: AbortSignal,
  ): Promise<DecodedPanoramaFrame>;

  findNearbyCoverage?(
    lat: number,
    lng: number,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata | null>;

  dispose?(): void;
}

export interface ValidatedLink {
  sourcePanoId: string;
  destinationPanoId: string;
  heading: number;
  text: string;
  distanceMeters: number;
  distanceEstimated: boolean;
}

export interface DirectionalChoice {
  link: ValidatedLink;
  relativeAngle: number;
  absAngle: number;
  direction: RelativeDirection;
}

export type JunctionKind =
  | 'dead-end'
  | 'corridor'
  | 'curve'
  | 't-junction'
  | 'intersection';

export interface JunctionSummary {
  kind: JunctionKind;
  label: string;
  isDeadEnd: boolean;
  isForwardBlocked: boolean;
  availableCount: number;
  forward: DirectionalChoice | null;
  left: DirectionalChoice | null;
  right: DirectionalChoice | null;
  reverse: DirectionalChoice | null;
  allChoices: DirectionalChoice[];
}

export interface CarInputState {
  accelerate: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  handbrake: boolean;
}

export type GlidePacePreset = 'walk' | 'slow' | 'cruise';

export interface CarTelemetry {
  speedKmh: number;
  speedMs: number;
  maxSpeedKmh: number;
  speedRatio: number;
  pace: GlidePacePreset;
  gear: GearMode;
  heading: number;
  steeringAngle: number;
  progressToNext: number;
  segmentDistanceMeters: number;
  segmentDistanceEstimated: boolean;
  totalDistanceMeters: number;
  isMoving: boolean;
  isAccelerating: boolean;
  isBraking: boolean;
  cruiseEnabled: boolean;
  targetLink: ValidatedLink | null;
}

export interface BufferMonitorSnapshot {
  displayedBuffer: BufferSlotId;
  displayedPanoId: string | null;
  stagingBuffer: BufferSlotId;
  stagingPanoId: string | null;
  stagingStatus: BufferReadiness;
  swapCount: number;
  lastPrepareMs: number;
  transitionDurationMs: 0;
}
