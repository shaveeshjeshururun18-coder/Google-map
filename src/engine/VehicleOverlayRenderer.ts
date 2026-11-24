import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { DrivingTelemetry, VehicleType } from '../types/streetview';
import {
  buildSportBikeModel,
  buildSportsCarModel,
  type VehicleRig,
} from './VehicleModels';

function detectSoftwareWebGL(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      return /SwiftShader|llvmpipe|Software|Mesa OffScreen/i.test(renderer);
    }
  } catch {
    // Ignore extension errors
  }
  return false;
}

const STREAK_COUNT = 28;

/**
 * Transparent Three.js WebGL overlay rendering the interactive 3D Car or 3D Motorcycle
 * directly on top of real Google Street View (works identically for both Map Tiles API
 * spherical mode and Maps JS StreetViewPanorama mode).
 */
export class VehicleOverlayRenderer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly envRT: THREE.WebGLRenderTarget;
  private readonly isSoftwareGl: boolean;

  private readonly vehicleAnchor = new THREE.Group();
  private carRig: VehicleRig;
  private bikeRig: VehicleRig;
  private activeType: VehicleType = 'car';

  // Peripheral speed motion streaks (visible at higher speeds)
  private readonly streakGeo: THREE.BufferGeometry;
  private readonly streakMat: THREE.LineBasicMaterial;
  private readonly streakLines: THREE.LineSegments;
  private readonly streakSeeds: Float32Array;

  // Smoothed visual kinematics state (zero GC allocations in loop)
  private telemetry: DrivingTelemetry = {
    speedKmh: 0,
    speedMs: 0,
    maxSpeedKmh: 120,
    speedRatio: 0,
    gear: 'D',
    heading: 0,
    steeringAngle: 0,
    lateralOffset: 0,
    lateralVelocity: 0,
    progressToNext: 0,
    segmentDistanceMeters: 12,
    segmentDistanceEstimated: true,
    totalDistanceMeters: 0,
    isMoving: false,
    isBraking: false,
    targetEdge: null,
  };

  private smoothedPitch = 0;
  private smoothedRoll = 0;
  private smoothedYaw = 0;
  private smoothedSteer = 0;
  private prevSpeedMs = 0;
  private roadPhase = 0;
  private wheelSpinAngle = 0;
  private lastFrameMs = 0;
  private rafId: number | null = null;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement, initialType: VehicleType = 'car') {
    this.container = container;
    this.activeType = initialType;

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
    });
    this.isSoftwareGl = detectSoftwareWebGL(this.renderer.getContext());

    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.isSoftwareGl ? 1 : 2),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    this.renderer.setClearColor(0x000000, 0);

    const dom = this.renderer.domElement;
    dom.style.width = '100%';
    dom.style.height = '100%';
    dom.style.display = 'block';
    dom.style.pointerEvents = 'none';
    dom.setAttribute('aria-hidden', 'true');
    dom.dataset.testid = 'vehicle-3d-canvas';
    this.container.appendChild(dom);

    this.scene = new THREE.Scene();

    // Neutral studio IBL environment so clearcoat car paint & chrome rims gleam realistically
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();

    // Outdoor 3/4 daylight key + sky/asphalt hemisphere lighting for rich sculptural depth
    const hemiLight = new THREE.HemisphereLight(0xb8d4ff, 0x1c202a, 0.92);
    this.scene.add(hemiLight);

    const sunKey = new THREE.DirectionalLight(0xfff5e6, 2.2);
    sunKey.position.set(9, 13, -5);
    this.scene.add(sunKey);

    const rimFill = new THREE.DirectionalLight(0x93c5fd, 0.78);
    rimFill.position.set(-8, 6, 7);
    this.scene.add(rimFill);

    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.2, 80);
    this.scene.add(this.vehicleAnchor);

    // Build both procedural 3D vehicles once for instant zero-hitch switching
    this.carRig = buildSportsCarModel(this.isSoftwareGl);
    this.carRig.root.scale.setScalar(0.84);
    this.bikeRig = buildSportBikeModel(this.isSoftwareGl);
    this.bikeRig.root.visible = false;

    this.vehicleAnchor.add(this.carRig.root);
    this.vehicleAnchor.add(this.bikeRig.root);
    this.setVehicleType(initialType);

    // Subtle peripheral speed-rush wind streaks (only visible above 42 km/h)
    this.streakSeeds = new Float32Array(STREAK_COUNT * 4); // x, y, z, length
    const streakPositions = new Float32Array(STREAK_COUNT * 6);
    for (let i = 0; i < STREAK_COUNT; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (2.6 + ((i * 37) % 100) * 0.032);
      const y = 0.45 + ((i * 53) % 100) * 0.026;
      const z = -18 + ((i * 71) % 100) * 0.24;
      const len = 1.4 + ((i * 29) % 10) * 0.16;
      this.streakSeeds[i * 4] = x;
      this.streakSeeds[i * 4 + 1] = y;
      this.streakSeeds[i * 4 + 2] = z;
      this.streakSeeds[i * 4 + 3] = len;
    }
    this.streakGeo = new THREE.BufferGeometry();
    this.streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3));
    this.streakMat = new THREE.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.streakLines = new THREE.LineSegments(this.streakGeo, this.streakMat);
    this.streakLines.frustumCulled = false;
    this.scene.add(this.streakLines);

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', this.resize);
    }
  }

  public setVehicleType(type: VehicleType): void {
    this.activeType = type;
    this.carRig.root.visible = type === 'car';
    this.bikeRig.root.visible = type === 'bike';
    this.updateCameraFraming();
  }

  public getVehicleType(): VehicleType {
    return this.activeType;
  }

  public updateTelemetry(next: DrivingTelemetry): void {
    this.telemetry = next;
  }

  private getActiveRig(): VehicleRig {
    return this.activeType === 'bike' ? this.bikeRig : this.carRig;
  }

  private updateCameraFraming(): void {
    const aspect = this.camera.aspect || 16 / 9;
    const isPortrait = aspect < 0.85;
    const isBike = this.activeType === 'bike';

    this.camera.fov = isPortrait ? 52 : 45;
    const camZ = isPortrait ? (isBike ? 8.6 : 11.2) : isBike ? 7.6 : 9.35;
    const camY = isPortrait ? 2.15 : isBike ? 1.88 : 2.05;
    // On portrait mobile, aim lower so the 3D vehicle sits comfortably ABOVE the taller cockpit dock
    const lookY = isPortrait ? 0.42 : isBike ? 1.32 : 1.48;

    this.camera.position.set(0, camY, camZ);
    this.camera.lookAt(0, lookY, 0);
    this.camera.updateProjectionMatrix();
  }

  public resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.updateCameraFraming();
    this.renderer.setSize(width, height, false);
  };

  public start(): void {
    if (this.rafId !== null || this.disposed) return;
    this.lastFrameMs = performance.now();
    this.scheduleNextFrame();
  }

  public stop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    this.rafId = window.requestAnimationFrame(this.renderFrame);
  }

  private renderFrame = (now: number): void => {
    this.rafId = null;
    if (this.disposed) return;

    const dt = Math.min(0.08, Math.max(0.001, (now - this.lastFrameMs) / 1000));
    this.lastFrameMs = now;

    this.stepVehicleAnimation(dt);
    this.renderer.render(this.scene, this.camera);

    if (this.isSoftwareGl) {
      // Pace software WebGL cleanly so UI and Street View stay responsive
      const next = () => {
        if (!this.disposed) {
          this.scheduleNextFrame();
        }
      };
      window.setTimeout(next, 16);
    } else {
      this.scheduleNextFrame();
    }
  };

  private stepVehicleAnimation(dt: number): void {
    const rig = this.getActiveRig();
    const t = this.telemetry;
    const isBike = this.activeType === 'bike';

    // Longitudinal acceleration estimate for realistic squat / brake nose-dive
    const accelMs2 = (t.speedMs - this.prevSpeedMs) / Math.max(0.01, dt);
    this.prevSpeedMs = t.speedMs;

    // 1. Lateral lane shift across the road (snappy & unmistakable!)
    const maxLateralMeters = isBike ? 1.85 : 1.75;
    const lateralX = t.lateralOffset * maxLateralMeters;
    this.vehicleAnchor.position.x = lateralX;

    // Subtle chase-camera follow so swerving feels visceral while keeping vehicle centered in frame
    const baseCamX = lateralX * 0.24;
    this.camera.position.x += (baseCamX - this.camera.position.x) * Math.min(1, dt * 10);

    // 2. Chassis yaw (noses into lane shift), roll (car leans out / bike leans sharply IN!), pitch (squat/dive)
    const targetYaw = -t.steeringAngle * 0.22 - Math.max(-0.26, Math.min(0.26, t.lateralVelocity * 0.065));
    const targetRoll = isBike
      ? -t.steeringAngle * 0.44 - Math.max(-0.34, Math.min(0.34, t.lateralVelocity * 0.085))
      : t.steeringAngle * 0.065 + Math.max(-0.075, Math.min(0.075, t.lateralVelocity * 0.022));
    const clampedAccel = Math.max(-22, Math.min(22, accelMs2));
    const targetPitch = t.isBraking ? -0.055 : clampedAccel * 0.0024;

    const blend = Math.min(1, dt * 14);
    this.smoothedYaw += (targetYaw - this.smoothedYaw) * blend;
    this.smoothedRoll += (targetRoll - this.smoothedRoll) * blend;
    this.smoothedPitch += (targetPitch - this.smoothedPitch) * Math.min(1, dt * 10);
    this.smoothedSteer += (t.steeringAngle - this.smoothedSteer) * Math.min(1, dt * 16);

    // Subtle asphalt road vibration & engine idle hum
    this.roadPhase += dt * (11 + t.speedRatio * 34);
    const roadRumble =
      (Math.sin(this.roadPhase) * 0.004 + Math.sin(this.roadPhase * 2.3) * 0.0025) *
      (0.18 + t.speedRatio * 1.15);

    rig.root.rotation.y = this.smoothedYaw;
    rig.chassis.position.y = roadRumble;
    rig.chassis.rotation.z = this.smoothedRoll;
    rig.chassis.rotation.x = this.smoothedPitch;

    // 3. Spin all wheels proportionally to road speed & steer front wheels/forks
    const dirSign = t.gear === 'R' ? 1 : -1;
    this.wheelSpinAngle += (dirSign * t.speedMs * dt) / Math.max(0.2, rig.wheelRadius);
    for (let i = 0; i < rig.spinWheels.length; i += 1) {
      rig.spinWheels[i].rotation.x = this.wheelSpinAngle;
    }

    const frontSteerRadians = -this.smoothedSteer * (isBike ? 0.34 : 0.42);
    for (let i = 0; i < rig.frontSteerPivots.length; i += 1) {
      rig.frontSteerPivots[i].rotation.y = frontSteerRadians;
    }

    // 4. Dynamic LED Brake Lights & Reverse Lights
    const targetBrakeIntensity = t.isBraking ? 4.4 : 1.65;
    rig.brakeLightMat.emissiveIntensity +=
      (targetBrakeIntensity - rig.brakeLightMat.emissiveIntensity) * Math.min(1, dt * 18);

    rig.reverseLightMat.emissiveIntensity = t.gear === 'R' && t.speedMs > 0.1 ? 3.2 : 0.05;

    // 5. Peripheral high-speed wind streaks (zero allocations)
    const streakIntensity = Math.max(0, Math.min(1, (t.speedKmh - 38) / 70));
    this.streakMat.opacity = streakIntensity * 0.34;
    if (streakIntensity > 0.01) {
      const posAttr = this.streakGeo.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      const streakSpeed = 24 + t.speedMs * 1.45;
      for (let i = 0; i < STREAK_COUNT; i += 1) {
        const seedIdx = i * 4;
        const x = this.streakSeeds[seedIdx];
        const y = this.streakSeeds[seedIdx + 1];
        let z = this.streakSeeds[seedIdx + 2] + streakSpeed * dt;
        const len = this.streakSeeds[seedIdx + 3] * (0.7 + streakIntensity * 1.35);
        if (z > 8.5) {
          z = -18 - (z - 8.5);
        }
        this.streakSeeds[seedIdx + 2] = z;

        const outIdx = i * 6;
        arr[outIdx] = x;
        arr[outIdx + 1] = y;
        arr[outIdx + 2] = z;
        arr[outIdx + 3] = x;
        arr[outIdx + 4] = y;
        arr[outIdx + 5] = z - len;
      }
      posAttr.needsUpdate = true;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    } else {
      window.removeEventListener('resize', this.resize);
    }

    this.carRig.dispose();
    this.bikeRig.dispose();
    this.streakGeo.dispose();
    this.streakMat.dispose();
    this.envRT.dispose();
    this.renderer.dispose();

    const dom = this.renderer.domElement;
    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}
