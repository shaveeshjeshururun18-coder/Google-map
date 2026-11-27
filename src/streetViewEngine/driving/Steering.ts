import {
  calculateAngularDifference,
  normalizeHeading,
} from '../navigation/DirectionCalculator';

export interface SteeringStepParams {
  headingDeg: number;
  steeringAngle: number;
  steerDir: -1 | 0 | 1;
  isReverseGear: boolean;
  steeringRateDegPerSec: number;
  isMovingForwardStraight: boolean;
  targetLinkHeading: number | null;
  dtSeconds: number;
}

export interface SteeringStepResult {
  headingDeg: number;
  steeringAngle: number;
  headingChanged: boolean;
}

/**
 * Pure virtual steering controller:
 * - Rotates camera/vehicle heading smoothly when A/D or Left/Right is held
 * - Self-centers the virtual steering wheel when released
 * - Gently tracks slight road curvature along the active forward link while driving straight
 */
export function stepSteering(params: SteeringStepParams): SteeringStepResult {
  const {
    steeringRateDegPerSec,
    isReverseGear,
    steerDir,
    isMovingForwardStraight,
    targetLinkHeading,
    dtSeconds,
  } = params;

  let headingDeg = normalizeHeading(params.headingDeg);
  let steeringAngle = params.steeringAngle;
  let headingChanged = false;

  if (steerDir !== 0) {
    const sign = isReverseGear ? -1 : 1;
    headingDeg = normalizeHeading(
      headingDeg + steerDir * sign * steeringRateDegPerSec * dtSeconds,
    );
    steeringAngle = Math.max(-1, Math.min(1, steeringAngle + steerDir * dtSeconds * 9.5));
    headingChanged = true;
  } else {
    steeringAngle *= Math.exp(-10 * dtSeconds);
    if (Math.abs(steeringAngle) < 0.008) {
      steeringAngle = 0;
    }

    // Gentle lane-follow assist along subtle curves when accelerating straight ahead
    if (isMovingForwardStraight && targetLinkHeading !== null) {
      const desired = isReverseGear
        ? normalizeHeading(targetLinkHeading + 180)
        : targetLinkHeading;
      const err = calculateAngularDifference(headingDeg, desired);
      if (Math.abs(err) > 0.4 && Math.abs(err) < 42) {
        headingDeg = normalizeHeading(headingDeg + err * Math.min(1, dtSeconds * 4.2));
        headingChanged = true;
      }
    }
  }

  return { headingDeg, steeringAngle, headingChanged };
}
