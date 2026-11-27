import {
  calculateAngularDifference,
  normalizeHeading,
} from '../navigation/DirectionCalculator';
import type { NavigationManager } from '../navigation/NavigationManager';
import type {
  DrivingInputState,
  DrivingTelemetry,
  GearMode,
  PanoramaEdge,
} from '../types/streetview';
import { DEFAULT_ESTIMATED_TRANSITION_METERS } from '../utils/geo';

export interface DrivingControllerConfig {
  maxForwardSpeedKmh: number;
  maxReverseSpeedKmh: number;
  cruiseSpeedKmh: number;
  accelerationMs2: number;
  brakingMs2: number;
  handbrakeMs2: number;
  coastDecelMs2: number;
  steeringDegPerSec: number;
  maxTimestepSeconds: number;
  preloadThreshold: number;
}

export interface DrivingCallbacks {
  onAdvanceToEdge?: (edge: PanoramaEdge, gear: GearMode) => void;
  onPreloadEdge?: (edge: PanoramaEdge) => void;
  onHeadingSteer?: (newHeadingDeg: number) => void;
  onDeadEndReached?: (gear: GearMode) => void;
}

const DEFAULT_CONFIG: DrivingControllerConfig = {
  maxForwardSpeedKmh: 120,
  maxReverseSpeedKmh: 36,
  cruiseSpeedKmh: 76,
  accelerationMs2: 19.5,
  brakingMs2: 28.0,
  handbrakeMs2: 46.0,
  coastDecelMs2: 4.5,
  steeringDegPerSec: 125,
  maxTimestepSeconds: 0.1,
  preloadThreshold: 0.02,
};

const KMH_PER_MS = 3.6;

// Virtual 5-speed automatic gear speed ranges (km/h) for lively RPM & audio sync
const GEAR_RANGES: Array<[number, number]> = [
  [0, 28],
  [22, 54],
  [46, 80],
  [72, 102],
  [94, 124],
];

export class DrivingController {
  private readonly config: DrivingControllerConfig;
  private readonly navigation: NavigationManager;
  private readonly callbacks: DrivingCallbacks;

  private input: DrivingInputState = {
    accelerate: false,
    brake: false,
    steerLeft: false,
    steerRight: false,
    handbrake: false,
    boost: false,
  };

  private currentPanoId: string | null = null;
  private heading = 0;
  private speedMs = 0; // non-negative magnitude; gear determines direction
  private gear: GearMode = 'D';
  private virtualGear = 1;
  private rpm = 0.16;
  private justShiftedGear = false;
  private driftIntensity = 0;
  private cruiseEnabled = false;

  private steeringAngle = 0; // -1..1 visual steering wheel angle
  private steerHoldSeconds = 0;
  private lateralOffset = 0; // -1..1 lane shift offset (left..right)
  private lateralVelocity = 0; // units/s lateral velocity for crisp swerve physics
  private lateralTarget = 0;
  private lateralHoldTimer = 0;

  private virtualProgressMeters = 0;
  private pendingOvershootMeters = 0;
  private coldHoldSeconds = 0;
  private totalDistanceMeters = 0;
  private activeTargetEdge: PanoramaEdge | null = null;
  private preloadedEdgeId: string | null = null;
  private transitionLocked = false;
  private deadEndNotified = false;

  constructor(
    navigation: NavigationManager,
    callbacks: DrivingCallbacks = {},
    config: Partial<DrivingControllerConfig> = {},
  ) {
    this.navigation = navigation;
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public setCurrentPanorama(panoId: string, headingDeg?: number): void {
    const isSeamlessAdvance = this.currentPanoId !== null && this.currentPanoId !== panoId;
    this.currentPanoId = panoId;
    if (headingDeg !== undefined && Number.isFinite(headingDeg)) {
      this.heading = normalizeHeading(headingDeg);
    }
    this.virtualProgressMeters = isSeamlessAdvance ? this.pendingOvershootMeters : 0;
    this.pendingOvershootMeters = 0;
    this.coldHoldSeconds = 0;
    this.preloadedEdgeId = null;
    this.transitionLocked = false;
    this.deadEndNotified = false;
    this.activeTargetEdge = this.resolveTargetEdge();
  }

  public syncHeadingFromCamera(headingDeg: number): void {
    const normalized = normalizeHeading(headingDeg);
    const prevTargetId = this.activeTargetEdge?.destinationPanoId ?? null;
    this.heading = normalized;
    this.activeTargetEdge = this.resolveTargetEdge();

    if (
      prevTargetId &&
      this.activeTargetEdge &&
      this.activeTargetEdge.destinationPanoId !== prevTargetId
    ) {
      this.virtualProgressMeters = 0;
      this.preloadedEdgeId = null;
    }
  }

  public setTransitionLocked(locked: boolean): void {
    this.transitionLocked = locked;
  }

  public setCruise(enabled: boolean): void {
    this.cruiseEnabled = enabled;
    if (enabled && this.gear === 'N') {
      this.gear = 'D';
    }
  }

  public toggleCruise(): boolean {
    this.setCruise(!this.cruiseEnabled);
    return this.cruiseEnabled;
  }

  public setInput<K extends keyof DrivingInputState>(
    key: K,
    active: boolean,
  ): void {
    const wasActive = this.input[key];
    this.input[key] = active;

    // Braking or handbrake cancels Cruise automatically like a real car
    if (active && (key === 'brake' || key === 'handbrake')) {
      this.cruiseEnabled = false;
    }

    // Instant lateral & steering impulse on initial key press for lively left/right swerves
    if (active && !wasActive) {
      if (key === 'steerLeft') {
        this.lateralVelocity = Math.min(this.lateralVelocity, -4.4);
        this.steeringAngle = Math.max(-1, this.steeringAngle - 0.42);
        this.lateralTarget = Math.max(-1, this.lateralOffset - 0.68);
        this.lateralHoldTimer = 0.3;
      } else if (key === 'steerRight') {
        this.lateralVelocity = Math.max(this.lateralVelocity, 4.4);
        this.steeringAngle = Math.min(1, this.steeringAngle + 0.42);
        this.lateralTarget = Math.min(1, this.lateralOffset + 0.68);
        this.lateralHoldTimer = 0.3;
      }
    }

    if (key === 'handbrake' && active) {
      this.deadEndNotified = false;
    }
  }

  /**
   * Instantly shifts the vehicle hard left (-1) or right (+1) across road lanes
   * without pulling the camera off the forward road line.
   */
  public nudgeLateral(direction: -1 | 1): void {
    const dir = direction < 0 ? -1 : 1;
    this.lateralTarget = Math.max(-1, Math.min(1, this.lateralOffset + dir * 0.9));
    this.lateralVelocity = dir * 6.8;
    this.steeringAngle = Math.max(-1, Math.min(1, this.steeringAngle + dir * 0.72));
    this.lateralHoldTimer = 0.55;
  }

  public resetInputs(): void {
    this.input = {
      accelerate: false,
      brake: false,
      steerLeft: false,
      steerRight: false,
      handbrake: false,
      boost: false,
    };
  }

  public setGear(gear: GearMode): void {
    if (this.gear === gear) return;
    this.gear = gear;
    this.cruiseEnabled = false;
    this.speedMs = 0;
    this.virtualGear = 1;
    this.virtualProgressMeters = 0;
    this.preloadedEdgeId = null;
    this.deadEndNotified = false;
    this.activeTargetEdge = this.resolveTargetEdge();
  }

  public toggleReverseGear(): GearMode {
    const nextGear: GearMode = this.gear === 'R' ? 'D' : 'R';
    this.setGear(nextGear);
    return nextGear;
  }

  public emergencyStop(): void {
    this.speedMs = 0;
    this.cruiseEnabled = false;
    this.virtualProgressMeters = 0;
    this.pendingOvershootMeters = 0;
    this.input.accelerate = false;
  }

  public getGear(): GearMode {
    return this.gear;
  }

  public getInputState(): DrivingInputState {
    return { ...this.input };
  }

  private resolveTargetEdge(): PanoramaEdge | null {
    if (!this.currentPanoId) return null;

    if (this.gear === 'R') {
      return (
        this.navigation.findReverseNeighbour(this.currentPanoId, this.heading)?.edge ?? null
      );
    }
    if (this.gear === 'D') {
      // Generous 76° forward capture cone so lively lane weaving never stalls on curves
      return (
        this.navigation.findForwardNeighbour(this.currentPanoId, this.heading, 76)?.edge ??
        null
      );
    }
    return null;
  }

  private getEffectiveSegmentDistance(edge: PanoramaEdge): number {
    const raw = Math.max(2, edge.distanceMeters || DEFAULT_ESTIMATED_TRANSITION_METERS);
    return Math.min(raw, Math.max(6.2, raw * 0.72));
  }

  private updateVirtualTransmission(speedKmh: number, accelerating: boolean, dt: number): void {
    this.justShiftedGear = false;
    if (this.gear === 'R') {
      this.virtualGear = 1;
      const targetRpm = 0.16 + Math.min(0.75, (speedKmh / Math.max(1, this.config.maxReverseSpeedKmh)) * 0.72);
      this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 10);
      return;
    }

    let nextGear = this.virtualGear;
    while (nextGear < GEAR_RANGES.length && speedKmh > GEAR_RANGES[nextGear - 1][1]) {
      nextGear += 1;
    }
    while (nextGear > 1 && speedKmh < GEAR_RANGES[nextGear - 1][0]) {
      nextGear -= 1;
    }

    if (nextGear > this.virtualGear && accelerating && speedKmh > 18) {
      this.justShiftedGear = true;
    }
    this.virtualGear = nextGear;

    const [minKmh, maxKmh] = GEAR_RANGES[this.virtualGear - 1];
    const span = Math.max(10, maxKmh - minKmh);
    const gearRatio = Math.max(0, Math.min(1, (speedKmh - minKmh) / span));
    const throttleRev = accelerating ? 0.12 : 0;
    const targetRpm = Math.min(0.98, 0.16 + gearRatio * 0.72 + throttleRev);
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 12);
  }

  /**
   * Advances vehicle kinematics, progressive lively steering, lateral lane-shifting,
   * road-curve tracking, virtual gearbox RPM, and continuous Street View progress.
   */
  public step(rawDtSeconds: number, isNextPanoReady = true): DrivingTelemetry {
    const dt = Math.max(
      0,
      Math.min(rawDtSeconds, this.config.maxTimestepSeconds),
    );

    if (dt > 0) {
      // 1. Smart Game-Feel Steering + Instant Lateral Lane Shift Physics
      const steerDir =
        (this.input.steerRight ? 1 : 0) - (this.input.steerLeft ? 1 : 0);
      const wantsDrive = (this.input.accelerate || this.cruiseEnabled) && this.gear !== 'N';
      const isActivelyDriving = wantsDrive || this.speedMs > 1.8;

      if (steerDir !== 0) {
        this.steerHoldSeconds = Math.min(1.5, this.steerHoldSeconds + dt);
        const steerSign = this.gear === 'R' ? -1 : 1;

        // Check if a real side-street turn exists in the steered direction
        const sideTurnEdge =
          this.currentPanoId && this.gear === 'D'
            ? steerDir < 0
              ? this.navigation.findLeftNeighbour(this.currentPanoId, this.heading)?.edge ?? null
              : this.navigation.findRightNeighbour(this.currentPanoId, this.heading)?.edge ?? null
            : null;

        // On straight corridors while actively driving with NO cross-street in the steered direction:
        // keep steering lively & dramatic (full lateral lane swerve + up to ±24° look-into-turn)
        // WITHOUT spinning 90° off-road into trees and stalling at a dead end!
        const roadBaseEdge = this.activeTargetEdge;
        if (isActivelyDriving && roadBaseEdge && !sideTurnEdge && this.gear === 'D') {
          const targetSwerveHeading = normalizeHeading(roadBaseEdge.heading + steerDir * 24);
          const diffToSwerve = calculateAngularDifference(this.heading, targetSwerveHeading);
          const maxStep = this.config.steeringDegPerSec * 0.72 * dt;
          const clampedDelta = Math.max(-maxStep, Math.min(maxStep, diffToSwerve));
          this.heading = normalizeHeading(this.heading + clampedDelta);
        } else {
          // At an intersection (real side street exists) or when stationary: allow full cornering / U-turn
          const progressiveFactor = sideTurnEdge
            ? 0.92
            : 0.6 + 0.4 * Math.min(1, this.steerHoldSeconds / 0.35);
          const deltaHeading =
            steerDir * steerSign * this.config.steeringDegPerSec * progressiveFactor * dt;
          this.heading = normalizeHeading(this.heading + deltaHeading);
        }

        this.steeringAngle = Math.max(
          -1,
          Math.min(1, this.steeringAngle + steerDir * dt * 10.5),
        );
        this.lateralTarget = Math.max(-1, Math.min(1, steerDir * 0.96));
        this.lateralHoldTimer = 0.28;
        this.callbacks.onHeadingSteer?.(this.heading);
      } else {
        this.steerHoldSeconds = 0;
        // Quick self-center on steering wheel
        this.steeringAngle *= Math.exp(-11 * dt);
        if (Math.abs(this.steeringAngle) < 0.008) {
          this.steeringAngle = 0;
        }
        if (this.lateralHoldTimer > 0) {
          this.lateralHoldTimer = Math.max(0, this.lateralHoldTimer - dt);
        } else {
          // Gently glide back toward center of lane when driving straight
          const returnRate = this.speedMs > 1 ? 2.5 : 1.7;
          this.lateralTarget *= Math.exp(-returnRate * dt);
          if (Math.abs(this.lateralTarget) < 0.01) {
            this.lateralTarget = 0;
          }
        }
      }

      // High-stiffness spring for sudden left/right lateral shifting
      const stiffness = steerDir !== 0 || this.lateralHoldTimer > 0 ? 86 : 28;
      const damping = steerDir !== 0 || this.lateralHoldTimer > 0 ? 13.8 : 8.5;
      const springForce =
        (this.lateralTarget - this.lateralOffset) * stiffness -
        this.lateralVelocity * damping;
      this.lateralVelocity += springForce * dt;
      this.lateralOffset += this.lateralVelocity * dt;

      if (this.lateralOffset > 1) {
        this.lateralOffset = 1;
        if (this.lateralVelocity > 0) this.lateralVelocity = 0;
      } else if (this.lateralOffset < -1) {
        this.lateralOffset = -1;
        if (this.lateralVelocity < 0) this.lateralVelocity = 0;
      }
      if (Math.abs(this.lateralOffset) < 0.002 && Math.abs(this.lateralVelocity) < 0.005) {
        this.lateralOffset = 0;
        this.lateralVelocity = 0;
      }

      // Resolve connected panorama for current heading and gear
      const prevEdgeId = this.activeTargetEdge?.destinationPanoId ?? null;
      this.activeTargetEdge = this.resolveTargetEdge();
      if (
        prevEdgeId &&
        this.activeTargetEdge &&
        prevEdgeId !== this.activeTargetEdge.destinationPanoId
      ) {
        this.virtualProgressMeters = 0;
        this.preloadedEdgeId = null;
      }

      // Smooth automatic road-curve following when driving straight so curves stay seamless
      if (
        wantsDrive &&
        steerDir === 0 &&
        this.activeTargetEdge &&
        this.speedMs > 1.0
      ) {
        const desiredHeading =
          this.gear === 'R'
            ? normalizeHeading(this.activeTargetEdge.heading + 180)
            : this.activeTargetEdge.heading;
        const angleErr = calculateAngularDifference(this.heading, desiredHeading);
        if (Math.abs(angleErr) > 0.35 && Math.abs(angleErr) < 62) {
          const assist = angleErr * Math.min(1, dt * 4.5);
          this.heading = normalizeHeading(this.heading + assist);
          this.callbacks.onHeadingSteer?.(this.heading);
        }
      }

      // 2. Longitudinal speed integration
      const isBoosting =
        this.input.boost && this.gear === 'D' && !this.input.brake && !this.input.handbrake;
      const maxSpeedKmh =
        this.gear === 'R'
          ? this.config.maxReverseSpeedKmh
          : isBoosting
            ? Math.round(this.config.maxForwardSpeedKmh * 1.35)
            : this.input.accelerate
              ? this.config.maxForwardSpeedKmh
              : this.cruiseEnabled
                ? this.config.cruiseSpeedKmh
                : this.config.maxForwardSpeedKmh;
      const maxSpeedMs = maxSpeedKmh / KMH_PER_MS;

      if (this.input.handbrake) {
        this.speedMs = Math.max(0, this.speedMs - this.config.handbrakeMs2 * dt);
      } else if (this.input.brake) {
        this.speedMs = Math.max(0, this.speedMs - this.config.brakingMs2 * dt);
      } else if (wantsDrive) {
        if (!this.activeTargetEdge) {
          this.speedMs = Math.max(0, this.speedMs - this.config.brakingMs2 * dt);
          this.cruiseEnabled = false;
          if (!this.deadEndNotified) {
            this.deadEndNotified = true;
            this.callbacks.onDeadEndReached?.(this.gear);
          }
        } else {
          this.deadEndNotified = false;
          if (this.speedMs < maxSpeedMs) {
            this.speedMs = Math.min(
              maxSpeedMs,
              this.speedMs + this.config.accelerationMs2 * dt,
            );
          } else {
            this.speedMs = Math.max(
              maxSpeedMs,
              this.speedMs - this.config.coastDecelMs2 * dt,
            );
          }
        }
      } else {
        this.speedMs = Math.max(0, this.speedMs - this.config.coastDecelMs2 * dt);
      }

      const speedKmh = this.speedMs * KMH_PER_MS;
      const speedRatio = Math.min(
        1,
        speedKmh / Math.max(1, this.gear === 'R' ? this.config.maxReverseSpeedKmh : this.config.maxForwardSpeedKmh),
      );
      this.updateVirtualTransmission(speedKmh, wantsDrive && Boolean(this.activeTargetEdge), dt);

      // Compute lively tire drift / hard-brake slip intensity for 3D smoke & audio chirp
      const swerveSlip = Math.min(1, (Math.abs(this.lateralVelocity) / 4.2) * (0.25 + speedRatio * 0.95));
      const brakeSlip =
        (this.input.handbrake || this.input.brake) && speedKmh > 18
          ? Math.min(1, (speedKmh / 60) * (this.input.handbrake ? 1.0 : 0.65))
          : 0;
      const targetDrift = Math.max(swerveSlip, brakeSlip);
      this.driftIntensity += (targetDrift - this.driftIntensity) * Math.min(1, dt * 16);

      // 3. Rapid speed-matched progress along the real connected panorama edge
      if (this.activeTargetEdge && this.speedMs > 0.05 && !this.transitionLocked) {
        const effectiveSegmentDistance = this.getEffectiveSegmentDistance(
          this.activeTargetEdge,
        );
        const currentRatio = this.virtualProgressMeters / effectiveSegmentDistance;

        // If the next panorama is still painting (rare cold intersection turn), elastically pace
        // only the final 14% instead of slamming into a frozen wall — zero jarring stop/gap!
        let stepMeters = this.speedMs * dt;
        const shouldHoldForColdTile =
          !isNextPanoReady && currentRatio >= 0.86 && this.coldHoldSeconds < 1.25;

        if (shouldHoldForColdTile) {
          this.coldHoldSeconds += dt;
          const remainingFrac = Math.max(0.03, 0.97 - currentRatio);
          stepMeters = Math.min(stepMeters * 0.25, effectiveSegmentDistance * remainingFrac * dt * 2.6);
          this.virtualProgressMeters = Math.min(
            effectiveSegmentDistance * 0.97,
            this.virtualProgressMeters + stepMeters,
          );
          this.totalDistanceMeters += stepMeters;
        } else {
          this.coldHoldSeconds = 0;
          this.virtualProgressMeters += stepMeters;
          this.totalDistanceMeters += stepMeters;
        }

        const progressRatio = this.virtualProgressMeters / effectiveSegmentDistance;

        if (
          progressRatio >= this.config.preloadThreshold &&
          this.preloadedEdgeId !== this.activeTargetEdge.destinationPanoId
        ) {
          this.preloadedEdgeId = this.activeTargetEdge.destinationPanoId;
          this.callbacks.onPreloadEdge?.(this.activeTargetEdge);
        }

        if (progressRatio >= 1) {
          const edgeToAdvance = this.activeTargetEdge;
          // Preserve exact overshoot distance for seamless C1 continuity on synchronous handoff,
          // and keep progress pinned at 1.0 (never snapping back to 0!) if a cold tile wait occurs.
          this.pendingOvershootMeters = Math.min(
            effectiveSegmentDistance * 0.35,
            Math.max(0, this.virtualProgressMeters - effectiveSegmentDistance),
          );
          this.virtualProgressMeters = effectiveSegmentDistance;
          this.transitionLocked = true;
          this.callbacks.onAdvanceToEdge?.(edgeToAdvance, this.gear);
        }
      } else if (!this.activeTargetEdge && this.speedMs === 0) {
        this.virtualProgressMeters = 0;
        this.pendingOvershootMeters = 0;
        this.coldHoldSeconds = 0;
      }
    }

    return this.getTelemetry();
  }

  public getTelemetry(): DrivingTelemetry {
    const maxSpeedKmh =
      this.gear === 'R'
        ? this.config.maxReverseSpeedKmh
        : this.config.maxForwardSpeedKmh;
    const speedKmh = this.speedMs * KMH_PER_MS;
    const segmentDistance = this.activeTargetEdge
      ? this.getEffectiveSegmentDistance(this.activeTargetEdge)
      : DEFAULT_ESTIMATED_TRANSITION_METERS;
    const progressToNext = this.activeTargetEdge
      ? Math.max(0, Math.min(1, this.virtualProgressMeters / segmentDistance))
      : 0;

    return {
      speedKmh,
      speedMs: this.speedMs,
      maxSpeedKmh,
      speedRatio: maxSpeedKmh > 0 ? Math.min(1, speedKmh / maxSpeedKmh) : 0,
      rpm: this.rpm,
      virtualGear: this.virtualGear,
      justShiftedGear: this.justShiftedGear,
      driftIntensity: this.driftIntensity,
      gear: this.gear,
      heading: this.heading,
      steeringAngle: this.steeringAngle,
      lateralOffset: this.lateralOffset,
      lateralVelocity: this.lateralVelocity,
      progressToNext,
      segmentDistanceMeters: this.activeTargetEdge
        ? Math.max(2, this.activeTargetEdge.distanceMeters)
        : DEFAULT_ESTIMATED_TRANSITION_METERS,
      segmentDistanceEstimated: this.activeTargetEdge
        ? this.activeTargetEdge.distanceEstimated
        : true,
      totalDistanceMeters: this.totalDistanceMeters,
      isMoving: this.speedMs > 0.2,
      isAccelerating: (this.input.accelerate || this.cruiseEnabled || this.input.boost) && Boolean(this.activeTargetEdge),
      isBraking: this.input.brake || this.input.handbrake,
      isBoosting: this.input.boost && this.gear === 'D' && !this.input.brake && !this.input.handbrake,
      cruiseEnabled: this.cruiseEnabled,
      targetEdge: this.activeTargetEdge,
    };
  }
}
