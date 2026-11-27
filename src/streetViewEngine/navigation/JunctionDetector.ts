import type {
  DirectionalChoice,
  JunctionKind,
  JunctionSummary,
  ValidatedLink,
} from '../types';
import {
  calculateAngularDifference,
  classifyRelativeDirection,
} from './DirectionCalculator';

const FORWARD_MAX_CONE_DEG = 58;
const REVERSE_MIN_ANGLE_DEG = 135;

/**
 * Intelligent navigation junction analyzer.
 * Evaluates all neighbouring links relative to the car's current heading:
 * - Forward: smallest angular difference within the forward cone
 * - Left: link closest to -90° (between -145° and -25°)
 * - Right: link closest to +90° (between +25° and +145°)
 * - Reverse: link closest to 180° (or previous panorama if directly linked)
 */
export function analyzeJunction(
  links: readonly ValidatedLink[],
  carHeadingDeg: number,
  previousPanoId?: string | null,
): JunctionSummary {
  const allChoices: DirectionalChoice[] = links.map((link) => {
    const relativeAngle = calculateAngularDifference(carHeadingDeg, link.heading);
    return {
      link,
      relativeAngle,
      absAngle: Math.abs(relativeAngle),
      direction: classifyRelativeDirection(carHeadingDeg, link.heading),
    };
  });

  // Sort by smallest angular difference from car heading
  allChoices.sort((a, b) => a.absAngle - b.absAngle);

  // 1. Forward: smallest angular difference within forward cone
  const forward = allChoices.find((c) => c.absAngle <= FORWARD_MAX_CONE_DEG) ?? null;

  // 2. Left turn: closest to -90° (excluding chosen forward link unless it's the only turn)
  const leftCandidates = allChoices
    .filter(
      (c) =>
        c.link.destinationPanoId !== forward?.link.destinationPanoId &&
        c.relativeAngle <= -25 &&
        c.relativeAngle >= -145,
    )
    .sort((a, b) => Math.abs(a.relativeAngle + 90) - Math.abs(b.relativeAngle + 90));
  const left = leftCandidates[0] ?? null;

  // 3. Right turn: closest to +90°
  const rightCandidates = allChoices
    .filter(
      (c) =>
        c.link.destinationPanoId !== forward?.link.destinationPanoId &&
        c.relativeAngle >= 25 &&
        c.relativeAngle <= 145,
    )
    .sort((a, b) => Math.abs(a.relativeAngle - 90) - Math.abs(b.relativeAngle - 90));
  const right = rightCandidates[0] ?? null;

  // 4. Reverse: closest to 180° (or fallback to directly linked previous panorama)
  const reverseCandidates = allChoices
    .filter((c) => c.absAngle >= REVERSE_MIN_ANGLE_DEG)
    .sort((a, b) => Math.abs(180 - a.absAngle) - Math.abs(180 - b.absAngle));
  let reverse: DirectionalChoice | null = reverseCandidates[0] ?? null;
  if (!reverse && previousPanoId) {
    reverse =
      allChoices.find((c) => c.link.destinationPanoId === previousPanoId) ?? null;
  }

  // Classify junction geometry for cockpit HUD clarity
  const count = allChoices.length;
  const isForwardBlocked = !forward;
  const isDeadEnd = count === 0 || (count === 1 && !forward);

  let kind: JunctionKind;
  let label: string;

  if (isDeadEnd) {
    kind = 'dead-end';
    label = count === 0 ? 'End of Street View Coverage' : 'Dead End · Turn Around';
  } else if (count >= 4) {
    kind = 'intersection';
    label = '4-Way Intersection';
  } else if (count === 3) {
    kind = 't-junction';
    label = left && right && !forward ? 'T-Junction' : '3-Way Junction';
  } else if (left || right) {
    kind = 'curve';
    label = 'Road Curve';
  } else {
    kind = 'corridor';
    label = 'Connected Road';
  }

  return {
    kind,
    label,
    isDeadEnd,
    isForwardBlocked,
    availableCount: count,
    forward,
    left,
    right,
    reverse,
    allChoices,
  };
}
