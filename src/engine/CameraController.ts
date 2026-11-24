import { calculateAngularDifference, normalizeHeading } from '../navigation/DirectionCalculator';

export interface CameraStateSnapshot {
  heading: number; // degrees [0, 360), 0 = North, 90 = East
  pitch: number; // degrees [-75, 75]
  fov: number; // degrees [45, 95]
  isDragging: boolean;
  isPointerLocked: boolean;
}

const MIN_PITCH = -75;
const MAX_PITCH = 75;
const MIN_FOV = 45;
const MAX_FOV = 95;
const DEFAULT_FOV = 75;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class CameraController {
  private heading = 0;
  private targetHeading = 0;
  private pitch = 0;
  private targetPitch = 0;
  private fov = DEFAULT_FOV;
  private targetFov = DEFAULT_FOV;
  private fovKick = 0;
  private isDragging = false;
  private isPointerLocked = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private dragDistanceAccum = 0;

  private boundElement: HTMLElement | null = null;
  private activePointerId: number | null = null;
  private onInteractionCallback?: () => void;

  public setHeadingImmediate(headingDeg: number): void {
    const norm = normalizeHeading(headingDeg);
    this.heading = norm;
    this.targetHeading = norm;
  }

  public setTargetHeading(headingDeg: number): void {
    this.targetHeading = normalizeHeading(headingDeg);
  }

  public nudgeHeading(deltaDeg: number): void {
    this.targetHeading = normalizeHeading(this.targetHeading + deltaDeg);
  }

  public setPitchImmediate(pitchDeg: number): void {
    const clamped = clamp(pitchDeg, MIN_PITCH, MAX_PITCH);
    this.pitch = clamped;
    this.targetPitch = clamped;
  }

  public setTargetPitch(pitchDeg: number): void {
    this.targetPitch = clamp(pitchDeg, MIN_PITCH, MAX_PITCH);
  }

  public setFov(fovDeg: number): void {
    this.targetFov = clamp(fovDeg, MIN_FOV, MAX_FOV);
  }

  public adjustFov(deltaDeg: number): void {
    this.targetFov = clamp(this.targetFov + deltaDeg, MIN_FOV, MAX_FOV);
  }

  public setSpeedFovKick(speedRatio: number): void {
    // Subtle 0..5° widening at speed for spatial depth cue
    this.fovKick = clamp(speedRatio, 0, 1) * 5;
  }

  public applyLookDelta(deltaX: number, deltaY: number, sensitivity = 0.22): void {
    this.targetHeading = normalizeHeading(this.targetHeading - deltaX * sensitivity);
    this.targetPitch = clamp(this.targetPitch + deltaY * sensitivity, MIN_PITCH, MAX_PITCH);
    this.onInteractionCallback?.();
  }

  public getHeading(): number {
    return this.heading;
  }

  public getTargetHeading(): number {
    return this.targetHeading;
  }

  public getPitch(): number {
    return this.pitch;
  }

  public getFov(): number {
    return clamp(this.fov + this.fovKick, MIN_FOV, MAX_FOV + 5);
  }

  public wasRecentDrag(): boolean {
    return this.dragDistanceAccum > 6;
  }

  public getSnapshot(): CameraStateSnapshot {
    return {
      heading: this.heading,
      pitch: this.pitch,
      fov: this.getFov(),
      isDragging: this.isDragging,
      isPointerLocked: this.isPointerLocked,
    };
  }

  /**
   * Advances damped camera orientation toward target angles.
   * Returns true if the camera moved noticeably this step.
   */
  public update(dtSeconds: number, isInstant = false): boolean {
    const safeDt = clamp(dtSeconds, 0.001, 0.1);
    const alpha = isInstant ? 1 : 1 - Math.exp(-14 * safeDt);

    const headingDiff = calculateAngularDifference(this.heading, this.targetHeading);
    const pitchDiff = this.targetPitch - this.pitch;
    const fovDiff = this.targetFov - this.fov;

    if (
      Math.abs(headingDiff) < 0.005 &&
      Math.abs(pitchDiff) < 0.005 &&
      Math.abs(fovDiff) < 0.005
    ) {
      this.heading = this.targetHeading;
      this.pitch = this.targetPitch;
      this.fov = this.targetFov;
      return false;
    }

    this.heading = normalizeHeading(this.heading + headingDiff * alpha);
    this.pitch = clamp(this.pitch + pitchDiff * alpha, MIN_PITCH, MAX_PITCH);
    this.fov = clamp(this.fov + fovDiff * alpha, MIN_FOV, MAX_FOV);
    return true;
  }

  public attach(element: HTMLElement, onInteraction?: () => void): void {
    this.detach();
    this.boundElement = element;
    this.onInteractionCallback = onInteraction;

    element.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
    element.addEventListener('wheel', this.handleWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  public detach(): void {
    if (this.boundElement) {
      this.boundElement.removeEventListener('pointerdown', this.handlePointerDown);
      this.boundElement.removeEventListener('wheel', this.handleWheel);
    }
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.boundElement = null;
    this.isDragging = false;
    this.activePointerId = null;
  }

  public togglePointerLock(): void {
    if (!this.boundElement) return;
    if (document.pointerLockElement === this.boundElement) {
      document.exitPointerLock?.();
    } else if (typeof this.boundElement.requestPointerLock === 'function') {
      try {
        this.boundElement.requestPointerLock();
      } catch {
        // Pointer lock may be disallowed in sandboxed iframes; drag look remains active
      }
    }
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    this.isDragging = true;
    this.activePointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.dragDistanceAccum = 0;
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.isPointerLocked) {
      // In pointer lock, moving mouse right turns view right (+heading)
      this.applyLookDelta(-event.movementX, -event.movementY, 0.16);
      return;
    }

    if (!this.isDragging || event.pointerId !== this.activePointerId) return;
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.dragDistanceAccum += Math.hypot(dx, dy);

    // Dragging panorama left-to-right rotates view counter-clockwise (natural grab-and-pan feel)
    this.applyLookDelta(dx, dy, 0.24);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.isDragging = false;
    this.activePointerId = null;
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.adjustFov(event.deltaY * 0.03);
    this.onInteractionCallback?.();
  };

  private readonly handlePointerLockChange = (): void => {
    this.isPointerLocked =
      Boolean(this.boundElement) && document.pointerLockElement === this.boundElement;
    this.onInteractionCallback?.();
  };
}
