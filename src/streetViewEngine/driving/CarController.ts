import { DEFAULT_ESTIMATED_TRANSITION_METERS } from '../../utils/geo';
import { normalizeHeading } from '../navigation/DirectionCalculator';
import type { RouteController } from '../navigation/RouteController';
import { CONTINUOUS_GLIDE_SPEC } from '../rendering/ContinuousGlide';
import type {
  CarInputState,
  CarTelemetry,
  GearMode,
  GlidePacePreset,
  ValidatedLink,
} from '../types';
import { stepSteering } from './Steering';

export interface CarControllerConfig {
  paceSpeedsKmh: Record<GlidePacePreset, number>;
  maxReverseSpeedKmh: number;
  accelerationMs2: number;
  brakingMs2: number;
  handbrakeMs2: number;
  coastDecelMs2: number;
  steeringDegPerSec: number;
  maxTimestepSeconds: number;
}

export interface CarControllerCallbacks {
  onHeadingChanged?: (newHeadingDeg: number) => void;
  onPrepareNextLink?: (link: ValidatedLink) => void;
  onCommitInstantSwap?: (link: ValidatedLink, gear: GearMode) => void;
  onDeadEndReached?: (gear: GearMode) => void;
}

/**
 * Calm, natural slow-movement speeds designed for seamless, continuous Street View gliding:
 * - walk:   8 km/h (~2.2 m/s, ~4.5s smooth glide per Street View segment)
 * - slow:  14 km/h (~3.9 m/s, ~2.6s smooth glide per segment — DEFAULT!)
 * - cruise: 24 km/h (~6.7 m/s, ~1.5s smooth glide per segment)
 */
const DEFAULT_CONFIG: CarControllerConfig = {
  paceSpeedsKmh: {
    walk: 8,
    slow: 14,
    cruise: 24,
  },
  maxReverseSpeedKmh: 10,
  accelerationMs2: 3.4,
  brakingMs2: 7.5,
  handbrakeMs2: 14.0,
  coastDecelMs2: 3.0,
  steeringDegPerSec: 68,
  maxTimestepSeconds: 0.1,
};

const KMH_PER_MS = 3.6;

/**
 * Continuous Slow-Glide Virtual Driving Controller.
 *
 * Unlike a slideshow/teleport step engine:
 * - Pressing Drive slowly accelerates into a calm, continuous forward glide.
 * - Progress advances smoothly from 0.0 -> 1.0 while the Dual-Buffer Optical Glide
 *   continuously expands Buffer A and brings pre-painted Buffer B forward at the exact
 *   same velocity, handing off seamlessly at 1.0 with zero freeze and zero jerk.
 * - If Buffer B is still downloading high-res tiles, forward progress elastically
 *   cushions before the crossfade window so no blurry frame or flash ever appears.
 */
export class CarController {
  private readonly route: RouteController;
  private readonly callbacks: CarControllerCallbacks;
  private readonly config: CarControllerConfig;

  private input: CarInputState = {
    accelerate: false,
    brake: false,
    steerLeft: false,
    steerRight: false,
    handbrake: false,
  };

  private currentPanoId: string | null = null;
  private heading = 0;
  private steeringAngle = 0;
  private speedMs = 0;
  private gear: GearMode = 'D';
  private pace: GlidePacePreset = 'slow';
  private cruiseEnabled = false;
  private progressMeters = 0;
  private totalDistanceMeters = 0;

  private targetLink: ValidatedLink | null = null;
  private preparedDestId: string | null = null;
  private swapInFlight = false;
  private deadEndNotified = false;

  constructor(
    route: RouteController,
    callbacks: CarControllerCallbacks = {},
    config: Partial<CarControllerConfig> = {},
  ) {
    this.route = route;
    this.callbacks = callbacks;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      paceSpeedsKmh: {
        ...DEFAULT_CONFIG.paceSpeedsKmh,
        ...(config.paceSpeedsKmh ?? {}),
      },
    };
  }

  public setCurrentPanorama(
    panoId: string,
    headingDeg?: number,
    carryOverNormalized = 0,
  ): void {
    this.currentPanoId = panoId;
    if (headingDeg !== undefined && Number.isFinite(headingDeg)) {
      this.heading = normalizeHeading(headingDeg);
    }
    this.preparedDestId = null;
    this.swapInFlight = false;
    this.deadEndNotified = false;
    this.targetLink = this.resolveTargetLink();

    if (this.targetLink && carryOverNormalized > 0) {
      const stepDist = this.getStepDistanceMeters(this.targetLink);
      this.progressMeters = Math.min(stepDist * 0.2, carryOverNormalized * stepDist);
    } else {
      this.progressMeters = 0;
    }

    // Immediately stage the single next connected viewpoint in Buffer B so glide stays uninterrupted
    if (this.targetLink) {
      this.requestPrepare(this.targetLink);
    }
  }

  public syncHeadingFromCamera(headingDeg: number): void {
    const normalized = normalizeHeading(headingDeg);
    const prevDest = this.targetLink?.destinationPanoId ?? null;
    this.heading = normalized;
    this.targetLink = this.resolveTargetLink();

    if (this.targetLink && this.targetLink.destinationPanoId !== prevDest) {
      this.progressMeters = 0;
      this.preparedDestId = null;
      this.requestPrepare(this.targetLink);
    }
  }

  public setSwapInFlight(locked: boolean): void {
    this.swapInFlight = locked;
  }

  public setPace(pace: GlidePacePreset): void {
    this.pace = pace;
  }

  public getPace(): GlidePacePreset {
    return this.pace;
  }

  public setInput<K extends keyof CarInputState>(key: K, active: boolean): void {
    this.input[key] = active;
    if (active && (key === 'brake' || key === 'handbrake')) {
      this.cruiseEnabled = false;
    }
    if (key === 'accelerate' && active && this.targetLink) {
      this.requestPrepare(this.targetLink);
    }
    if (key === 'handbrake' && active) {
      this.deadEndNotified = false;
    }
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
    this.cruiseEnabled = false;
    this.speedMs = 0;
    this.progressMeters = 0;
    this.preparedDestId = null;
    this.deadEndNotified = false;
    this.targetLink = this.resolveTargetLink();
    if (this.targetLink) {
      this.requestPrepare(this.targetLink);
    }
  }

  public toggleReverseGear(): GearMode {
    const next: GearMode = this.gear === 'R' ? 'D' : 'R';
    this.setGear(next);
    return next;
  }

  public toggleCruise(): boolean {
    this.cruiseEnabled = !this.cruiseEnabled;
    if (this.cruiseEnabled && this.gear === 'N') {
      this.gear = 'D';
    }
    if (this.cruiseEnabled && this.targetLink) {
      this.requestPrepare(this.targetLink);
    }
    return this.cruiseEnabled;
  }

  public emergencyStop(): void {
    this.speedMs = 0;
    this.cruiseEnabled = false;
    this.progressMeters = 0;
    this.input.accelerate = false;
  }

  public getInputState(): CarInputState {
    return { ...this.input };
  }

  private resolveTargetLink(): ValidatedLink | null {
    if (!this.currentPanoId) return null;
    if (this.gear === 'R') {
      return this.route.resolveDirection('reverse', this.heading, this.currentPanoId)?.link ?? null;
    }
    if (this.gear === 'D') {
      return this.route.resolveDirection('forward', this.heading, this.currentPanoId)?.link ?? null;
    }
    return null;
  }

  private requestPrepare(link: ValidatedLink): void {
    if (this.preparedDestId === link.destinationPanoId) return;
    this.preparedDestId = link.destinationPanoId;
    this.callbacks.onPrepareNextLink?.(link);
  }

  private getStepDistanceMeters(link: ValidatedLink): number {
    const raw = Math.max(6, link.distanceMeters || DEFAULT_ESTIMATED_TRANSITION_METERS);
    return Math.min(raw, 12);
  }

  private getActiveTargetSpeedKmh(): number {
    if (this.gear === 'R') {
      return this.config.maxReverseSpeedKmh;
    }
    return this.config.paceSpeedsKmh[this.pace];
  }

  public step(rawDtSeconds: number, isBufferBReady = true): CarTelemetry {
    const dt = Math.max(0, Math.min(rawDtSeconds, this.config.maxTimestepSeconds));

    if (dt > 0) {
      const steerDir: -1 | 0 | 1 =
        this.input.steerRight && !this.input.steerLeft
          ? 1
          : this.input.steerLeft && !this.input.steerRight
            ? -1
            : 0;
      const wantsDrive = (this.input.accelerate || this.cruiseEnabled) && this.gear !== 'N';

      // 1. Gentle steering & road curve alignment
      const steerOut = stepSteering({
        headingDeg: this.heading,
        steeringAngle: this.steeringAngle,
        steerDir,
        isReverseGear: this.gear === 'R',
        steeringRateDegPerSec: this.config.steeringDegPerSec,
        isMovingForwardStraight: wantsDrive && steerDir === 0 && this.speedMs > 0.3,
        targetLinkHeading: this.targetLink?.heading ?? null,
        dtSeconds: dt,
      });

      this.heading = steerOut.headingDeg;
      this.steeringAngle = steerOut.steeringAngle;
      if (steerOut.headingChanged) {
        this.callbacks.onHeadingChanged?.(this.heading);
      }

      // 2. Refresh active connected link if steering selected a new branch
      const prevDestId = this.targetLink?.destinationPanoId ?? null;
      this.targetLink = this.resolveTargetLink();
      if (this.targetLink && this.targetLink.destinationPanoId !== prevDestId) {
        this.progressMeters = 0;
        this.preparedDestId = null;
        this.requestPrepare(this.targetLink);
      }

      // 3. Calm, silky acceleration & braking kinematics
      const targetSpeedMs = this.getActiveTargetSpeedKmh() / KMH_PER_MS;

      if (this.input.handbrake) {
        this.speedMs = Math.max(0, this.speedMs - this.config.handbrakeMs2 * dt);
      } else if (this.input.brake) {
        this.speedMs = Math.max(0, this.speedMs - this.config.brakingMs2 * dt);
      } else if (wantsDrive) {
        if (!this.targetLink) {
          this.speedMs = Math.max(0, this.speedMs - this.config.brakingMs2 * dt);
          this.cruiseEnabled = false;
          if (!this.deadEndNotified) {
            this.deadEndNotified = true;
            this.callbacks.onDeadEndReached?.(this.gear);
          }
        } else {
          this.deadEndNotified = false;
          if (this.speedMs < targetSpeedMs) {
            this.speedMs = Math.min(targetSpeedMs, this.speedMs + this.config.accelerationMs2 * dt);
          } else {
            this.speedMs = Math.max(targetSpeedMs, this.speedMs - this.config.coastDecelMs2 * dt);
          }
        }
      } else {
        this.speedMs = Math.max(0, this.speedMs - this.config.coastDecelMs2 * dt);
      }

      // 4. Advance continuous glide progress along the road segment
      if (this.targetLink && this.speedMs > 0.02 && !this.swapInFlight) {
        this.requestPrepare(this.targetLink);

        const stepDist = this.getStepDistanceMeters(this.targetLink);
        const cushionMeters = stepDist * CONTINUOUS_GLIDE_SPEC.unreadyCushionProgress;

        let effectiveSpeedMs = this.speedMs;
        if (!isBufferBReady && this.progressMeters >= stepDist * 0.14) {
          // Smoothly cushion forward motion before blend window while Buffer B finishes painting
          const remaining = Math.max(0, cushionMeters - this.progressMeters);
          const damping = Math.max(0.08, Math.min(1, remaining / Math.max(0.5, stepDist * 0.22)));
          effectiveSpeedMs *= damping;
        }

        const deltaMeters = effectiveSpeedMs * dt;
        const nextMeters = this.progressMeters + deltaMeters;

        if (!isBufferBReady && nextMeters >= cushionMeters) {
          this.progressMeters = cushionMeters;
        } else {
          this.progressMeters = nextMeters;
          this.totalDistanceMeters += deltaMeters;
        }

        // Seamless C1-continuous handoff once progress reaches 100% AND Buffer B is crisp & ready
        if (this.progressMeters >= stepDist && isBufferBReady) {
          const linkToEnter = this.targetLink;
          this.progressMeters = stepDist;
          this.swapInFlight = true;
          this.callbacks.onCommitInstantSwap?.(linkToEnter, this.gear);
        }
      } else if (!this.targetLink && this.speedMs === 0) {
        this.progressMeters = 0;
      }
    }

    return this.getTelemetry();
  }

  public getTelemetry(): CarTelemetry {
    const maxSpeedKmh = this.getActiveTargetSpeedKmh();
    const speedKmh = this.speedMs * KMH_PER_MS;
    const stepDist = this.targetLink
      ? this.getStepDistanceMeters(this.targetLink)
      : DEFAULT_ESTIMATED_TRANSITION_METERS;
    const progressToNext = this.targetLink
      ? Math.max(0, Math.min(1, this.progressMeters / stepDist))
      : 0;

    return {
      speedKmh,
      speedMs: this.speedMs,
      maxSpeedKmh,
      speedRatio: maxSpeedKmh > 0 ? Math.min(1, speedKmh / maxSpeedKmh) : 0,
      pace: this.pace,
      gear: this.gear,
      heading: this.heading,
      steeringAngle: this.steeringAngle,
      progressToNext,
      segmentDistanceMeters: this.targetLink
        ? Math.max(2, this.targetLink.distanceMeters)
        : DEFAULT_ESTIMATED_TRANSITION_METERS,
      segmentDistanceEstimated: this.targetLink ? this.targetLink.distanceEstimated : true,
      totalDistanceMeters: this.totalDistanceMeters,
      isMoving: this.speedMs > 0.08,
      isAccelerating: (this.input.accelerate || this.cruiseEnabled) && Boolean(this.targetLink),
      isBraking: this.input.brake || this.input.handbrake,
      cruiseEnabled: this.cruiseEnabled,
      targetLink: this.targetLink,
    };
  }
}
