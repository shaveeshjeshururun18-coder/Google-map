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
  accelerationMs2: 19.5,
  brakingMs2: 28.0,
  handbrakeMs2: 46.0,
  coastDecelMs2: 4.5,
  steeringDegPerSec: 125,
  maxTimestepSeconds: 0.1,
  preloadThreshold: 0.02,
};

const KMH_PER_MS = 3.6;

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
  };

  private currentPanoId: string | null = null;
  private heading = 0;
  private speedMs = 0; // non-negative magnitude; gear determines direction
  private gear: GearMode = 'D';
  private steeringAngle = 0; // -1..1 visual steering wheel angle
  private lateralOffset = 0; // -1..1 lane shift offset (left..right)
  private lateralVelocity = 0; // units/s lateral velocity for crisp swerve physics
  private lateralTarget = 0;
  private lateralHoldTimer = 0;
  private virtualProgressMeters = 0;
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
    this.currentPanoId = panoId;
    if (headingDeg !== undefined && Number.isFinite(headingDeg)) {
      this.heading = normalizeHeading(headingDeg);
    }
    this.virtualProgressMeters = 0;
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

    // If the driver rotated onto a different branch, reset partial progress cleanly
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

  public setInput<K extends keyof DrivingInputState>(
    key: K,
    active: boolean,
  ): void {
    const wasActive = this.input[key];
    this.input[key] = active;

    // Instant lateral & steering impulse on initial key press for snappy sudden left/right swerves
    if (active && !wasActive) {
      if (key === 'steerLeft') {
        this.lateralVelocity = Math.min(this.lateralVelocity, -3.4);
        this.steeringAngle = Math.max(-1, this.steeringAngle - 0.32);
        this.lateralTarget = Math.max(-1, this.lateralOffset - 0.55);
      } else if (key === 'steerRight') {
        this.lateralVelocity = Math.max(this.lateralVelocity, 3.4);
        this.steeringAngle = Math.min(1, this.steeringAngle + 0.32);
        this.lateralTarget = Math.min(1, this.lateralOffset + 0.55);
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
    this.lateralTarget = Math.max(-1, Math.min(1, this.lateralOffset + dir * 0.85));
    this.lateralVelocity = dir * 6.2;
    this.steeringAngle = Math.max(-1, Math.min(1, this.steeringAngle + dir * 0.65));
    this.lateralHoldTimer = 0.55;
  }

  public resetInputs(): void {
    this.input = {
      accelerate: false,
      brake: false,
      steerLeft: false,
      steerRight: false,
      handbrake: false,
    };
  }

  public setGear(gear: GearMode): void {
    if (this.gear === gear) return;
    this.gear = gear;
    this.speedMs = 0;
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
    this.virtualProgressMeters = 0;
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
      return (
        this.navigation.findForwardNeighbour(this.currentPanoId, this.heading, 68)?.edge ??
        null
      );
    }
    return null;
  }

  private getEffectiveSegmentDistance(edge: PanoramaEdge): number {
    const raw = Math.max(2, edge.distanceMeters || DEFAULT_ESTIMATED_TRANSITION_METERS);
    // Keep transitions crisp and responsive at high driving speeds
    return Math.min(raw, Math.max(5.5, raw * 0.68));
  }

  /**
   * Advances vehicle kinematics, snappy lateral lane-shifting, and rapid
   * speed-matched progress between real Street View viewpoints.
   */
  public step(rawDtSeconds: number): DrivingTelemetry {
    const dt = Math.max(
      0,
      Math.min(rawDtSeconds, this.config.maxTimestepSeconds),
    );

    if (dt > 0) {
      // 1. Snappy steering + instant lateral lane shift physics
      const steerDir =
        (this.input.steerRight ? 1 : 0) - (this.input.steerLeft ? 1 : 0);

      if (steerDir !== 0) {
        const steerSign = this.gear === 'R' ? -1 : 1;
        const deltaHeading =
          steerDir * steerSign * this.config.steeringDegPerSec * dt;
        this.heading = normalizeHeading(this.heading + deltaHeading);
        this.steeringAngle = Math.max(
          -1,
          Math.min(1, this.steeringAngle + steerDir * dt * 9.5),
        );
        this.lateralTarget = Math.max(-1, Math.min(1, steerDir * 0.95));
        this.lateralHoldTimer = 0.25;
        this.callbacks.onHeadingSteer?.(this.heading);
      } else {
        // Quick self-center on steering wheel
        this.steeringAngle *= Math.exp(-11 * dt);
        if (Math.abs(this.steeringAngle) < 0.008) {
          this.steeringAngle = 0;
        }
        if (this.lateralHoldTimer > 0) {
          this.lateralHoldTimer = Math.max(0, this.lateralHoldTimer - dt);
        } else {
          // Gently glide back toward center of lane when driving straight
          const returnRate = this.speedMs > 1 ? 2.4 : 1.6;
          this.lateralTarget *= Math.exp(-returnRate * dt);
          if (Math.abs(this.lateralTarget) < 0.01) {
            this.lateralTarget = 0;
          }
        }
      }

      // Critically-damped high-stiffness spring for sudden left/right lateral shifting
      const stiffness = steerDir !== 0 || this.lateralHoldTimer > 0 ? 78 : 26;
      const damping = steerDir !== 0 || this.lateralHoldTimer > 0 ? 13.5 : 8.5;
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

      // Lane-assist alignment toward real road bearing when accelerating straight
      if (
        this.input.accelerate &&
        steerDir === 0 &&
        this.activeTargetEdge &&
        this.speedMs > 1.5
      ) {
        const desiredHeading =
          this.gear === 'R'
            ? normalizeHeading(this.activeTargetEdge.heading + 180)
            : this.activeTargetEdge.heading;
        const angleErr = calculateAngularDifference(this.heading, desiredHeading);
        if (Math.abs(angleErr) > 0.4 && Math.abs(angleErr) < 46) {
          const assist = angleErr * Math.min(1, dt * 3.4);
          this.heading = normalizeHeading(this.heading + assist);
          this.callbacks.onHeadingSteer?.(this.heading);
        }
      }

      // 2. Longitudinal speed integration
      const maxSpeedMs =
        (this.gear === 'R'
          ? this.config.maxReverseSpeedKmh
          : this.config.maxForwardSpeedKmh) / KMH_PER_MS;

      if (this.input.handbrake) {
        this.speedMs = Math.max(0, this.speedMs - this.config.handbrakeMs2 * dt);
      } else if (this.input.brake) {
        this.speedMs = Math.max(0, this.speedMs - this.config.brakingMs2 * dt);
      } else if (this.input.accelerate && this.gear !== 'N') {
        if (!this.activeTargetEdge) {
          // No connected Street View panorama in this direction: smoothly stop and notify
          this.speedMs = Math.max(0, this.speedMs - this.config.brakingMs2 * dt);
          if (!this.deadEndNotified) {
            this.deadEndNotified = true;
            this.callbacks.onDeadEndReached?.(this.gear);
          }
        } else {
          this.deadEndNotified = false;
          this.speedMs = Math.min(
            maxSpeedMs,
            this.speedMs + this.config.accelerationMs2 * dt,
          );
        }
      } else {
        this.speedMs = Math.max(0, this.speedMs - this.config.coastDecelMs2 * dt);
      }

      // 3. Rapid speed-matched progress along the real connected panorama edge
      if (this.activeTargetEdge && this.speedMs > 0.05 && !this.transitionLocked) {
        const effectiveSegmentDistance = this.getEffectiveSegmentDistance(
          this.activeTargetEdge,
        );
        const stepMeters = this.speedMs * dt;
        this.virtualProgressMeters += stepMeters;
        this.totalDistanceMeters += stepMeters;

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
          this.virtualProgressMeters = 0;
          this.transitionLocked = true;
          this.callbacks.onAdvanceToEdge?.(edgeToAdvance, this.gear);
        }
      } else if (!this.activeTargetEdge && this.speedMs === 0) {
        this.virtualProgressMeters = 0;
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
      isBraking: this.input.brake || this.input.handbrake,
      targetEdge: this.activeTargetEdge,
    };
  }
}
