import type { RelativeDirection } from '../types';

const CARDINAL_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function normalizeHeading(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/**
 * Shortest signed angular difference from `carHeadingDeg` to `linkHeadingDeg` in (-180, 180].
 * Positive = right (clockwise), negative = left (counter-clockwise).
 */
export function calculateAngularDifference(
  carHeadingDeg: number,
  linkHeadingDeg: number,
): number {
  const from = normalizeHeading(carHeadingDeg);
  const to = normalizeHeading(linkHeadingDeg);
  let diff = ((to - from + 540) % 360) - 180;
  if (diff <= -180) {
    diff += 360;
  }
  return diff;
}

/**
 * Classifies a neighbouring panorama link relative to the car's heading:
 * - Smallest angular difference (<= 28°): forward
 * - ~90° left: left turn
 * - ~90° right: right turn
 * - ~180°: reverse
 */
export function classifyRelativeDirection(
  carHeadingDeg: number,
  linkHeadingDeg: number,
): RelativeDirection {
  const diff = calculateAngularDifference(carHeadingDeg, linkHeadingDeg);
  const abs = Math.abs(diff);

  if (abs <= 28) return 'forward';
  if (abs >= 140) return 'reverse';
  if (diff > 28 && diff <= 55) return 'slight-right';
  if (diff > 55 && diff < 140) return 'right';
  if (diff < -28 && diff >= -55) return 'slight-left';
  return 'left';
}

export function getCardinalLabel(headingDeg: number): string {
  const norm = normalizeHeading(headingDeg);
  const index = Math.round(norm / 45) % 8;
  return CARDINAL_LABELS[index];
}

export function formatHeading(headingDeg: number): string {
  const norm = Math.round(normalizeHeading(headingDeg)) % 360;
  return `${String(norm).padStart(3, '0')}° ${getCardinalLabel(norm)}`;
}

export function getDirectionLabel(direction: RelativeDirection): string {
  switch (direction) {
    case 'forward':
      return 'Forward';
    case 'slight-right':
      return 'Bear Right';
    case 'right':
      return 'Right';
    case 'slight-left':
      return 'Bear Left';
    case 'left':
      return 'Left';
    case 'reverse':
      return 'Reverse';
  }
}
