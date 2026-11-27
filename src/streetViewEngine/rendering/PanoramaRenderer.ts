import * as THREE from 'three';
import { CameraController } from '../../engine/CameraController';
import {
  computeSphereYawRadians,
  detectSoftwareWebGL,
  isWebGLAvailable,
} from '../../engine/PanoramaRenderer';
import { degToRad } from '../../utils/geo';
import type { GearMode, PanoramaMetadata, ValidatedLink } from '../types';
import { CONTINUOUS_GLIDE_SPEC, smootherstep } from './ContinuousGlide';
import { DoubleBuffer } from './DoubleBuffer';

export interface InstantPanoramaRendererCallbacks {
  onFrame?: (dtSeconds: number) => void;
  onRoadMarkerClick?: (link: ValidatedLink) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

const SPHERE_RADIUS = 50;
const MARKER_RING_RADIUS = 12;

const PROJECTIVE_GLIDE_VERTEX = /* glsl */ `
varying vec3 vWorldDir;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

/**
 * Projective 3D Street-Corridor Dual-Panorama View-Interpolation Shader.
 *
 * Projects every screen ray onto a 3D proxy street corridor (ground road plane at y = -2.4m,
 * lateral street facades at radius ~15m, distant sky dome) and translates the virtual camera
 * forward smoothly from Panorama A to Panorama B while cross-morphing with C2 smootherstep.
 */
const PROJECTIVE_GLIDE_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uYawA;
uniform float uYawB;
uniform float uHasTexA;
uniform float uHasTexB;
uniform float uProgress;
uniform float uBlendAlpha;
uniform float uStepMeters;
uniform vec3 uMoveDir;

varying vec3 vWorldDir;

const float PI = 3.14159265359;

// Estimate 3D street-corridor proxy depth for realistic ground & facade parallax
float estimateCorridorDepth(vec3 dir) {
  // Ground plane at camera height 2.4m
  if (dir.y < -0.025) {
    float groundDist = 2.4 / max(0.025, -dir.y);
    return min(groundDist, 42.0);
  }
  // Sky dome overhead barely moves (distant horizon)
  if (dir.y > 0.22) {
    return 85.0;
  }
  // Lateral street facades / trees blend smoothly between corridor wall (15m) and horizon
  float horizFactor = 1.0 - smoothstep(-0.025, 0.22, dir.y);
  return mix(85.0, 16.0, horizFactor * 0.72);
}

vec2 dirToEquirectUv(vec3 dir, float yawOffset) {
  float c = cos(yawOffset);
  float s = sin(yawOffset);
  // Rotate world direction into panorama local frame around Y axis
  vec3 localDir = vec3(
    c * dir.x - s * dir.z,
    dir.y,
    s * dir.x + c * dir.z
  );
  vec3 n = normalize(localDir);
  float lon = atan(n.x, -n.z);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float u = fract(lon / (2.0 * PI) + 0.5);
  float v = lat / PI + 0.5;
  return vec2(u, v);
}

void main() {
  if (uHasTexA < 0.5) {
    gl_FragColor = vec4(0.043, 0.055, 0.078, 1.0);
    return;
  }

  vec3 viewDir = normalize(vWorldDir);
  float depth = estimateCorridorDepth(viewDir);
  vec3 proxyPoint = viewDir * depth;

  // Virtual camera moves forward along uMoveDir from 0 -> uStepMeters
  vec3 camOffsetA = uMoveDir * (uProgress * uStepMeters);
  vec3 rayA = normalize(proxyPoint - camOffsetA);
  vec4 colorA = texture2D(uTexA, dirToEquirectUv(rayA, uYawA));

  if (uHasTexB < 0.5 || uBlendAlpha <= 0.001) {
    gl_FragColor = colorA;
    return;
  }

  // Incoming Panorama B approaches from -uStepMeters -> 0 at the exact same velocity
  vec3 camOffsetB = uMoveDir * ((uProgress - 1.0) * uStepMeters);
  vec3 rayB = normalize(proxyPoint - camOffsetB);
  vec4 colorB = texture2D(uTexB, dirToEquirectUv(rayB, uYawB));

  gl_FragColor = mix(colorA, colorB, uBlendAlpha);
}
`;

function createPlaceholderTexture(): THREE.DataTexture {
  const data = new Uint8Array([11, 14, 20, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Three.js 360° Projective Street-Corridor Continuous-Glide Renderer.
 * Used when raw Street View Map Tiles API or an independently licensed 360° dataset is active.
 */
export class InstantPanoramaRenderer {
  public readonly isSoftwareGl: boolean;
  private readonly container: HTMLElement;
  private readonly cameraController: CameraController;
  private readonly callbacks: InstantPanoramaRendererCallbacks;
  private readonly doubleBuffer = new DoubleBuffer<THREE.CanvasTexture>();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly glideMaterial: THREE.ShaderMaterial;
  private readonly sphereMesh: THREE.Mesh;
  private readonly placeholderTexture: THREE.DataTexture;

  private readonly markerGroup: THREE.Group;
  private readonly chevronGeometry: THREE.ExtrudeGeometry;
  private readonly clickableMeshes: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly lookTarget = new THREE.Vector3();

  private resizeObserver: ResizeObserver | null = null;
  private frameHandle = 0;
  private isDisposed = false;
  private isRunning = false;
  private lastFrameTimeMs = 0;

  constructor(
    container: HTMLElement,
    cameraController: CameraController,
    callbacks: InstantPanoramaRendererCallbacks = {},
  ) {
    if (!isWebGLAvailable()) {
      throw new Error('WebGL is unavailable in this browser environment.');
    }

    this.container = container;
    this.cameraController = cameraController;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e14);

    const width = Math.max(1, container.clientWidth || window.innerWidth);
    const height = Math.max(1, container.clientHeight || window.innerHeight);

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 200);
    this.camera.position.set(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.setAttribute('data-testid', 'panorama-canvas');
    this.renderer.domElement.setAttribute('aria-label', '360-degree Street View panorama');

    container.appendChild(this.renderer.domElement);

    this.placeholderTexture = createPlaceholderTexture();
    this.sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 48, 32);
    this.sphereGeometry.scale(-1, 1, 1);

    this.glideMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTexA: { value: this.placeholderTexture },
        uTexB: { value: this.placeholderTexture },
        uYawA: { value: 0 },
        uYawB: { value: 0 },
        uHasTexA: { value: 0 },
        uHasTexB: { value: 0 },
        uProgress: { value: 0 },
        uBlendAlpha: { value: 0 },
        uStepMeters: { value: 6.5 },
        uMoveDir: { value: new THREE.Vector3(0, 0, -1) },
      },
      vertexShader: PROJECTIVE_GLIDE_VERTEX,
      fragmentShader: PROJECTIVE_GLIDE_FRAGMENT,
      depthWrite: true,
    });

    this.sphereMesh = new THREE.Mesh(this.sphereGeometry, this.glideMaterial);
    this.scene.add(this.sphereMesh);

    this.chevronGeometry = this.createRoadChevronGeometry();
    this.markerGroup = new THREE.Group();
    this.markerGroup.renderOrder = 5;
    this.scene.add(this.markerGroup);

    this.cameraController.attach(this.renderer.domElement);
    this.renderer.domElement.addEventListener('click', this.handleCanvasClick);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', this.handleResize);
  }

  private createRoadChevronGeometry(): THREE.ExtrudeGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.85);
    shape.lineTo(0.75, -0.35);
    shape.lineTo(0.42, -0.55);
    shape.lineTo(0, 0.18);
    shape.lineTo(-0.42, -0.55);
    shape.lineTo(-0.75, -0.35);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.08,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.03,
      bevelThickness: 0.03,
    });
    geo.rotateX(-Math.PI / 2);
    geo.center();
    return geo;
  }

  public getMaxTextureSize(): number {
    const hwMax = this.renderer.capabilities.maxTextureSize || 2048;
    return this.isSoftwareGl ? Math.min(hwMax, 2048) : Math.min(hwMax, 4096);
  }

  private uploadCanvasToGpuTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    return texture;
  }

  public stagePanoramaInBufferB(metadata: PanoramaMetadata, canvas: HTMLCanvasElement): void {
    if (this.isDisposed) return;
    const prevStaging = this.doubleBuffer.getStaging();
    if (prevStaging.payload) {
      prevStaging.payload.dispose();
    }
    this.doubleBuffer.beginPrepare(metadata.panoId);
    const texture = this.uploadCanvasToGpuTexture(canvas);
    this.doubleBuffer.markStagingReady(metadata, texture);

    this.glideMaterial.uniforms.uTexB.value = texture;
    this.glideMaterial.uniforms.uYawB.value = computeSphereYawRadians(metadata.heading);
    this.glideMaterial.uniforms.uHasTexB.value = 1;
  }

  public isBufferBReadyFor(panoId: string): boolean {
    return this.doubleBuffer.isStagingReadyFor(panoId);
  }

  /**
   * Updates the real-time 3D projective street-corridor glide shader on every 60fps frame.
   */
  public updateGlideState(
    progress: number,
    moveHeadingDeg: number,
    gear: GearMode,
    hasReadyTarget: boolean,
  ): void {
    if (this.isDisposed) return;
    const clamped = Math.max(0, Math.min(1, progress));
    const effective = hasReadyTarget
      ? clamped
      : Math.min(clamped, CONTINUOUS_GLIDE_SPEC.unreadyCushionProgress);
    const blend = hasReadyTarget
      ? smootherstep(
          CONTINUOUS_GLIDE_SPEC.blendStart,
          CONTINUOUS_GLIDE_SPEC.blendEnd,
          effective,
        )
      : 0;

    const rad = degToRad(moveHeadingDeg);
    const dirSign = gear === 'R' ? -1 : 1;
    (this.glideMaterial.uniforms.uMoveDir.value as THREE.Vector3).set(
      Math.sin(rad) * dirSign,
      0,
      -Math.cos(rad) * dirSign,
    );
    this.glideMaterial.uniforms.uProgress.value = effective;
    this.glideMaterial.uniforms.uBlendAlpha.value = blend;
  }

  public commitInstantSwap(expectedPanoId: string): boolean {
    if (this.isDisposed) return false;
    const result = this.doubleBuffer.commitSwap(expectedPanoId);
    if (!result.swapped || !result.displayed.payload || !result.displayed.metadata) {
      return false;
    }

    this.glideMaterial.uniforms.uTexA.value = result.displayed.payload;
    this.glideMaterial.uniforms.uYawA.value = computeSphereYawRadians(
      result.displayed.metadata.heading,
    );
    this.glideMaterial.uniforms.uHasTexA.value = 1;
    this.glideMaterial.uniforms.uTexB.value = this.placeholderTexture;
    this.glideMaterial.uniforms.uHasTexB.value = 0;
    this.glideMaterial.uniforms.uProgress.value = 0;
    this.glideMaterial.uniforms.uBlendAlpha.value = 0;

    if (result.evictedPayload && result.evictedPayload !== result.displayed.payload) {
      result.evictedPayload.dispose();
    }
    return true;
  }

  public displayInitialPanorama(metadata: PanoramaMetadata, canvas: HTMLCanvasElement): void {
    if (this.isDisposed) return;
    const texture = this.uploadCanvasToGpuTexture(canvas);
    const oldDisplayed = this.doubleBuffer.getDisplayed().payload;
    this.doubleBuffer.setInitialDisplayed(metadata, texture);

    this.glideMaterial.uniforms.uTexA.value = texture;
    this.glideMaterial.uniforms.uYawA.value = computeSphereYawRadians(metadata.heading);
    this.glideMaterial.uniforms.uHasTexA.value = 1;
    this.glideMaterial.uniforms.uTexB.value = this.placeholderTexture;
    this.glideMaterial.uniforms.uHasTexB.value = 0;
    this.glideMaterial.uniforms.uProgress.value = 0;
    this.glideMaterial.uniforms.uBlendAlpha.value = 0;

    if (oldDisplayed && oldDisplayed !== texture) {
      oldDisplayed.dispose();
    }
  }

  public setRoadMarkers(links: ValidatedLink[], activeDestId: string | null): void {
    if (this.isDisposed) return;
    for (const mesh of this.clickableMeshes) {
      (mesh.material as THREE.Material).dispose();
    }
    this.clickableMeshes.length = 0;
    while (this.markerGroup.children.length > 0) {
      this.markerGroup.remove(this.markerGroup.children[0]);
    }

    for (const link of links) {
      const isPrimary = link.destinationPanoId === activeDestId;
      const rad = degToRad(link.heading);
      const material = new THREE.MeshBasicMaterial({
        color: isPrimary ? 0xf59e0b : 0xe2e8f0,
        transparent: true,
        opacity: isPrimary ? 0.92 : 0.55,
        depthWrite: false,
      });

      const chevron = new THREE.Mesh(this.chevronGeometry, material);
      chevron.position.set(
        Math.sin(rad) * MARKER_RING_RADIUS,
        -3.4,
        -Math.cos(rad) * MARKER_RING_RADIUS,
      );
      chevron.rotation.y = -rad;
      chevron.scale.setScalar(isPrimary ? 1.15 : 0.92);
      chevron.userData = { link };
      chevron.renderOrder = 5;
      this.markerGroup.add(chevron);
      this.clickableMeshes.push(chevron);
    }
  }

  public start(): void {
    if (this.isRunning || this.isDisposed) return;
    this.isRunning = true;
    this.lastFrameTimeMs = performance.now();
    this.tick();
  }

  public stop(): void {
    this.isRunning = false;
    cancelAnimationFrame(this.frameHandle);
    clearTimeout(this.frameHandle);
  }

  private readonly tick = (): void => {
    if (!this.isRunning || this.isDisposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastFrameTimeMs) / 1000));
    this.lastFrameTimeMs = now;

    this.callbacks.onFrame?.(dt);
    this.cameraController.update(dt, this.isSoftwareGl);
    this.applyCameraOrientation();
    this.renderer.render(this.scene, this.camera);

    if (this.isSoftwareGl) {
      this.frameHandle = window.setTimeout(this.tick, 60);
    } else {
      this.frameHandle = requestAnimationFrame(this.tick);
    }
  };

  private applyCameraOrientation(): void {
    const headingRad = degToRad(this.cameraController.getHeading());
    const pitchRad = degToRad(this.cameraController.getPitch());
    const cosPitch = Math.cos(pitchRad);

    this.lookTarget.set(
      Math.sin(headingRad) * cosPitch,
      Math.sin(pitchRad),
      -Math.cos(headingRad) * cosPitch,
    );
    this.camera.lookAt(this.lookTarget);

    const nextFov = this.cameraController.getFov();
    if (Math.abs(this.camera.fov - nextFov) > 0.05) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private readonly handleResize = (): void => {
    if (this.isDisposed) return;
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly handleCanvasClick = (event: MouseEvent): void => {
    if (this.cameraController.wasRecentDrag() || this.clickableMeshes.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickableMeshes, false);
    if (hits.length > 0) {
      const link = hits[0].object.userData?.link as ValidatedLink | undefined;
      if (link) {
        this.callbacks.onRoadMarkerClick?.(link);
      }
    }
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.stop();
    this.callbacks.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    this.start();
    this.callbacks.onContextRestored?.();
  };

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stop();
    this.cameraController.detach();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleResize);

    const dom = this.renderer.domElement;
    dom.removeEventListener('click', this.handleCanvasClick);
    dom.removeEventListener('webglcontextlost', this.handleContextLost);
    dom.removeEventListener('webglcontextrestored', this.handleContextRestored);

    const { displayedPayload, stagingPayload } = this.doubleBuffer.reset();
    displayedPayload?.dispose();
    stagingPayload?.dispose();
    this.placeholderTexture.dispose();

    this.glideMaterial.dispose();
    this.sphereGeometry.dispose();
    this.chevronGeometry.dispose();
    for (const mesh of this.clickableMeshes) {
      (mesh.material as THREE.Material).dispose();
    }
    this.clickableMeshes.length = 0;

    this.renderer.dispose();
    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}
