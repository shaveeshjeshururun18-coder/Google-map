export interface StreetViewAddressComponent {
  longName: string;
  shortName: string;
  types: string[];
}

export interface StreetViewLink {
  panoId: string;
  heading: number;
  text?: string;
}

export interface PanoramaMetadata {
  panoId: string;
  lat: number;
  lng: number;
  originalLat?: number;
  originalLng?: number;
  imageHeight: number;
  imageWidth: number;
  tileHeight: number;
  tileWidth: number;
  heading: number;
  tilt?: number;
  roll?: number;
  imageryType?: 'outdoor' | 'indoor' | string;
  date?: string;
  copyright: string;
  reportProblemLink: string;
  addressComponents?: StreetViewAddressComponent[];
  links: StreetViewLink[];
  streetName: string;
  formattedLocation: string;
}

export interface PanoramaEdge {
  sourcePanoId: string;
  destinationPanoId: string;
  heading: number;
  text: string;
  distanceMeters: number;
  distanceEstimated: boolean;
}

export interface PanoramaNode {
  panoId: string;
  metadata: PanoramaMetadata;
  discoveredAt: number;
  visitedCount: number;
}

export type RelativeDirection =
  | 'forward'
  | 'slight-right'
  | 'right'
  | 'slight-left'
  | 'left'
  | 'reverse';

export interface RankedNeighbour {
  edge: PanoramaEdge;
  relativeAngle: number;
  absAngle: number;
  direction: RelativeDirection;
}

export interface NavigationHistoryEntry {
  panoId: string;
  lat: number;
  lng: number;
  streetName: string;
  enteredAt: number;
  heading: number;
}

export interface DeadEndStatus {
  isDeadEnd: boolean;
  isForwardBlocked: boolean;
  isIntersection: boolean;
  availableCount: number;
}

export type GearMode = 'D' | 'R' | 'N';

export type VehicleType = 'car' | 'bike';

export type DriveMode = '3d-world' | 'street-view';

export interface DrivingInputState {
  accelerate: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  handbrake: boolean;
  boost: boolean;
}

export interface DrivingTelemetry {
  speedKmh: number;
  speedMs: number;
  maxSpeedKmh: number;
  speedRatio: number; // 0..1 normalized speed
  rpm: number; // 0..1 normalized engine RPM synced to virtual gears
  virtualGear: number; // 1..6 forward transmission gear
  justShiftedGear: boolean; // one-frame pulse on upshift for exhaust pop & pitch kick
  driftIntensity: number; // 0..1 lateral tire slip / hard brake intensity
  gear: GearMode;
  heading: number;
  steeringAngle: number;
  lateralOffset: number; // -1..1 instant lane shift offset (left..right)
  lateralVelocity: number; // instantaneous lateral swerve velocity
  progressToNext: number; // 0..1 virtual progress between discrete panoramas (or RPM ratio in 3D World)
  segmentDistanceMeters: number;
  segmentDistanceEstimated: boolean;
  totalDistanceMeters: number;
  isMoving: boolean;
  isAccelerating: boolean;
  isBraking: boolean;
  isBoosting: boolean;
  cruiseEnabled: boolean;
  targetEdge: PanoramaEdge | null;
}

export interface TileGridSpec {
  zoom: number;
  maxZoom: number;
  tilesX: number;
  tilesY: number;
  tileWidth: number;
  tileHeight: number;
  levelWidth: number;
  levelHeight: number;
}

export type QualityPreset = 'fast' | 'balanced' | 'high';

export interface TransitionState {
  isTransitioning: boolean;
  fromPanoId: string | null;
  toPanoId: string | null;
  blendProgress: number; // 0..1
  tilesLoaded: number;
  tilesTotal: number;
  phase: 'idle' | 'fetching-metadata' | 'loading-tiles' | 'blending' | 'error';
  message: string;
}

export interface PlaceSuggestion {
  placeId: string;
  mainText: string;
  secondaryText: string;
  fullText: string;
  types: string[];
}

export interface PlaceResult {
  placeId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  types: string[];
}

export interface SimulatorError {
  code: string;
  title: string;
  message: string;
  recoverable: boolean;
  isQuotaError?: boolean;
  isAuthError?: boolean;
  suggestedLocation?: {
    lat: number;
    lng: number;
    label: string;
  };
}

export interface StreetViewSessionInfo {
  active: boolean;
  expiryMs: number;
  tileWidth: number;
  tileHeight: number;
  imageFormat: string;
  language: string;
  region: string;
}
