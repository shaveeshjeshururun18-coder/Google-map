import type { GearMode } from '../types';

export interface ContinuousGlideSpec {
  /** Base Street View WebGL zoom (wide natural FOV so scale = scaleRatio matches ~90°). */
  readonly baseZoom: number;
  /**
   * Exponential optical-flow expansion factor per ~10m Street View segment (r = 1.26).
   * Forward:
   *  - Top Buffer A:        scaleA(t) = r^(1 + t)  [1.26 -> 1.5876]
   *  - Underneath Buffer B: scaleB(t) = r^t        [1.00 -> 1.26]
   * At handoff (t = 1 -> next t = 0):
   *  - Buffer A is already opacity = 0.0
   *  - Buffer B arrives at scale = 1.26 === next Buffer A's exact starting scale!
   *  - Logarithmic optical-flow rate d(ln scale)/dt = ln(r)/T is C-infinity continuous!
   *  - Minimum scale is ALWAYS >= 1.00 (zero black borders ever!).
   */
  readonly scaleRatio: number;
  /** Normalized progress t where cross-morph opacity dissolve begins. */
  readonly blendStart: number;
  /** Normalized progress t where outgoing panorama reaches 0% opacity. */
  readonly blendEnd: number;
  /** Maximum normalized progress allowed while Buffer B is still downloading tiles. */
  readonly unreadyCushionProgress: number;
}

export const CONTINUOUS_GLIDE_SPEC: ContinuousGlideSpec = Object.freeze({
  baseZoom: 0.65,
  scaleRatio: 1.26,
  blendStart: 0.14,
  blendEnd: 0.92,
  unreadyCushionProgress: 0.36,
});

export interface GlideFrameInput {
  /** Normalized progress along the current road segment [0, 1]. */
  progress: number;
  /** Active gear ('D' = forward optical expansion, 'R' = reverse recession, 'N' = stationary). */
  gear: GearMode;
  /** Whether standby Buffer B has finished painting high-res tiles for the target panoId. */
  isBufferBReady: boolean;
}

export interface GlideFrameState {
  /** Effective clamped progress [0, 1]. */
  progress: number;
  /** GPU canvas scale for currently displayed top Buffer A (always >= 1.0). */
  displayedScale: number;
  /** GPU canvas scale for pre-painted incoming Buffer B (always >= 1.0, velocity-matched). */
  stagingScale: number;
  /** Opacity for top Buffer A [0, 1]. Stays 1.0 until Buffer B is completely ready. */
  displayedOpacity: number;
  /** Opacity for underneath Buffer B (always 1.0 so no dark backdrop ever shows through). */
  stagingOpacity: number;
  /** Normalized cross-morph factor [0, 1] (0 = 100% A, 1 = 100% B). */
  blendAlpha: number;
  /** True when gently cushioning progress while waiting for Buffer B tiles to finish painting. */
  isCushioning: boolean;
}

/**
 * Ken Perlin's C2-continuous quintic smootherstep curve:
 * zero first AND second derivatives at edge0 and edge1 so the cross-morph
 * begins and ends imperceptibly with zero visual pop.
 */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Computes C-infinity exponential optical-flow scales and C2 smootherstep cross-morph
 * opacities for continuous, slow, jerk-free Street View forward and reverse movement.
 */
export function computeGlideFrame(
  input: GlideFrameInput,
  spec: ContinuousGlideSpec = CONTINUOUS_GLIDE_SPEC,
): GlideFrameState {
  const r = spec.scaleRatio;
  const rawProgress = Number.isFinite(input.progress)
    ? Math.max(0, Math.min(1, input.progress))
    : 0;

  if (input.gear === 'N' || rawProgress <= 0.0001) {
    return {
      progress: 0,
      displayedScale: r,
      stagingScale: input.gear === 'R' ? r * r : 1,
      displayedOpacity: 1,
      stagingOpacity: 1,
      blendAlpha: 0,
      isCushioning: false,
    };
  }

  const isReverse = input.gear === 'R';
  const isCushioning = !input.isBufferBReady && rawProgress >= spec.blendStart;
  const effectiveProgress = input.isBufferBReady
    ? rawProgress
    : Math.min(rawProgress, spec.unreadyCushionProgress);

  // Forward: A expands r -> r^2, B expands 1 -> r (identical d(ln scale)/dt = +ln(r)/T)
  // Reverse: A recedes r -> 1,   B recedes r^2 -> r (identical d(ln scale)/dt = -ln(r)/T)
  const displayedScale = isReverse
    ? Math.pow(r, 1 - effectiveProgress)
    : Math.pow(r, 1 + effectiveProgress);
  const stagingScale = isReverse
    ? Math.pow(r, 2 - effectiveProgress)
    : Math.pow(r, effectiveProgress);

  const blendAlpha = input.isBufferBReady
    ? smootherstep(spec.blendStart, spec.blendEnd, effectiveProgress)
    : 0;

  return {
    progress: effectiveProgress,
    displayedScale,
    stagingScale,
    displayedOpacity: 1 - blendAlpha,
    stagingOpacity: 1,
    blendAlpha,
    isCushioning,
  };
}
