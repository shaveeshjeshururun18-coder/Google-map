import type { RelativeDirection } from '../types/streetview';

const CARDINAL_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function normalizeHeading(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/**
 * Returns shortest signed angular difference from `fromDeg` to `toDeg` in (-180, 180].
 * Positive values indicate clockwise (rightward) rotation; negative values indicate left.
 */
export function calculateAngularDifference(fromDeg: number, toDeg: number): number {
  const from = normalizeHeading(fromDeg);
  const to = normalizeHeading(toDeg);
  let diff = ((to - from + 540) % 360) - 180;
  if (diff <= -180) {
    diff += 360;
  }
  return diff;
}

/**
 * Classifies a link heading relative to the current camera/vehicle heading.
 */
export function calculateRelativeDirection(
  cameraHeadingDeg: number,
  linkHeadingDeg: number,
): RelativeDirection {
  const diff = calculateAngularDifference(cameraHeadingDeg, linkHeadingDeg);
  const abs = Math.abs(diff);

  if (abs <= 25) return 'forward';
  if (abs >= 145) return 'reverse';
  if (diff > 25 && diff <= 55) return 'slight-right';
  if (diff > 55 && diff < 145) return 'right';
  if (diff < -25 && diff >= -55) return 'slight-left';
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

export function getRelativeDirectionLabel(direction: RelativeDirection): string {
  switch (direction) {
    case 'forward':
      return 'Straight';
    case 'slight-right':
      return 'Bear Right';
    case 'right':
      return 'Turn Right';
    case 'slight-left':
      return 'Bear Left';
    case 'left':
      return 'Turn Left';
    case 'reverse':
      return 'Reverse';
  }
}
