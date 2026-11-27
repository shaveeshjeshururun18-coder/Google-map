import * as THREE from 'three';

export interface InstantSwapSpec {
  readonly transitionDurationMs: 0;
  readonly fadeEnabled: false;
  readonly interpolationEnabled: false;
}

/**
 * Enforces the architectural rule:
 * 0 ms atomic hard cut — NO fade, NO opacity blend, NO CSS scale/zoom interpolation.
 */
export const INSTANT_SWAP_SPEC: InstantSwapSpec = Object.freeze({
  transitionDurationMs: 0,
  fadeEnabled: false,
  interpolationEnabled: false,
});

/**
 * Performs an atomic single-frame DOM buffer flip between Buffer A and Buffer B.
 * Both elements keep opacity: 1, transition: none, transform: none — only zIndex
 * and pointerEvents flip synchronously in the same JS task (0 ms hard cut).
 */
export function swapDomBuffersInstant(
  incomingEl: HTMLElement,
  outgoingEl: HTMLElement,
): void {
  incomingEl.style.transition = 'none';
  incomingEl.style.opacity = '1';
  incomingEl.style.transform = 'none';
  incomingEl.style.visibility = 'visible';
  incomingEl.style.zIndex = '2';
  incomingEl.style.pointerEvents = 'auto';

  outgoingEl.style.transition = 'none';
  outgoingEl.style.opacity = '1';
  outgoingEl.style.transform = 'none';
  outgoingEl.style.visibility = 'visible';
  outgoingEl.style.zIndex = '1';
  outgoingEl.style.pointerEvents = 'none';
}

/**
 * Performs an atomic single-frame Three.js sphere texture pointer replacement (0 ms hard cut).
 */
export function swapSphereTextureInstant(
  material: THREE.MeshBasicMaterial,
  nextTexture: THREE.Texture,
): THREE.Texture | null {
  const previousTexture = material.map;
  material.map = nextTexture;
  material.color.setHex(0xffffff);
  material.opacity = 1;
  material.transparent = false;
  material.needsUpdate = true;
  return previousTexture && previousTexture !== nextTexture ? previousTexture : null;
}
