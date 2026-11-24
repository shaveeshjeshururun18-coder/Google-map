import * as THREE from 'three';
import type { PanoramaEdge, PanoramaMetadata } from '../types/streetview';
import { degToRad } from '../utils/geo';
import type { CameraController } from './CameraController';

export interface PanoramaRendererCallbacks {
  onFrame?: (dtSeconds: number) => void;
  onRoadMarkerClick?: (edge: PanoramaEdge) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

const SPHERE_RADIUS = 50;
const MARKER_RING_RADIUS = 12;

export function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes the Three.js Y-rotation aligning an equirectangular Street View sphere
 * (inverted via scale(-1, 1, 1), so u=0.5 faces -X) with true world compass heading.
 * World coordinates: North (0°) = -Z, East (90°) = +X, South (180°) = +Z, West (270°) = -X.
 */
export function computeSphereYawRadians(panoHeadingDeg: number): number {
  return -degToRad(panoHeadingDeg) - Math.PI / 2;
}

export class PanoramaRenderer {
  public readonly isSoftwareGl: boolean;
  private readonly container: HTMLElement;
  private readonly cameraController: CameraController;
  private readonly callbacks: PanoramaRendererCallbacks;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly primaryMesh: THREE.Mesh;
  private readonly primaryMaterial: THREE.MeshBasicMaterial;
  private readonly incomingMesh: THREE.Mesh;
  private readonly incomingMaterial: THREE.MeshBasicMaterial;

  private readonly markerGroup: THREE.Group;
  private readonly chevronGeometry: THREE.ExtrudeGeometry;
  private readonly clickableMeshes: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly lookTarget = new THREE.Vector3();

  private primaryTexture: THREE.CanvasTexture | null = null;
  private incomingTexture: THREE.CanvasTexture | null = null;
  private hoveredEdgeId: string | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private frameHandle = 0;
  private isDisposed = false;
  private isRunning = false;
  private lastFrameTimeMs = 0;
  private lastRaycastMs = 0;

  constructor(
    container: HTMLElement,
    cameraController: CameraController,
    callbacks: PanoramaRendererCallbacks = {},
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
    this.renderer.toneMapping = THREE.NoToneMapping; // Preserve authentic Street View photographic colors
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.setAttribute('data-testid', 'panorama-canvas');
    this.renderer.domElement.setAttribute('aria-label', '360-degree Google Street View panorama');

    container.appendChild(this.renderer.domElement);

    // Inverted inward-facing sphere so equirectangular Street View tiles map right-side-out without mirroring
    this.sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 48, 32);
    this.sphereGeometry.scale(-1, 1, 1);

    this.primaryMaterial = new THREE.MeshBasicMaterial({
      color: 0x0b0e14,
      depthWrite: true,
    });
    this.primaryMesh = new THREE.Mesh(this.sphereGeometry, this.primaryMaterial);
    this.primaryMesh.rotation.order = 'YXZ';
    this.primaryMesh.renderOrder = 0;
    this.scene.add(this.primaryMesh);

    this.incomingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.incomingMesh = new THREE.Mesh(this.sphereGeometry, this.incomingMaterial);
    this.incomingMesh.rotation.order = 'YXZ';
    this.incomingMesh.scale.setScalar(0.98);
    this.incomingMesh.visible = false;
    this.incomingMesh.renderOrder = 1;
    this.scene.add(this.incomingMesh);

    // Build shared beveled 3D road chevron geometry for real Street View navigation links
    this.chevronGeometry = this.createRoadChevronGeometry();
    this.markerGroup = new THREE.Group();
    this.markerGroup.renderOrder = 5;
    this.scene.add(this.markerGroup);

    // Attach camera drag / touch / pointer-lock controls to the WebGL canvas
    this.cameraController.attach(this.renderer.domElement);

    // Listen for clicks & hover on 3D road arrows
    this.renderer.domElement.addEventListener('click', this.handleCanvasClick);
    this.renderer.domElement.addEventListener('pointermove', this.handleCanvasPointerMove);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', this.handleResize);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
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

  private createPanoramaTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  private orientSphere(mesh: THREE.Mesh, metadata: PanoramaMetadata): void {
    mesh.rotation.y = computeSphereYawRadians(metadata.heading);

    // Apply subtle horizon tilt/roll correction when provided by Street View metadata
    const tiltCorrection =
      typeof metadata.tilt === 'number' && Number.isFinite(metadata.tilt)
        ? degToRad(Math.max(-15, Math.min(15, metadata.tilt - 90)))
        : 0;
    const rollCorrection =
      typeof metadata.roll === 'number' && Number.isFinite(metadata.roll)
        ? degToRad(Math.max(-15, Math.min(15, metadata.roll > 180 ? metadata.roll - 360 : metadata.roll)))
        : 0;

    mesh.rotation.x = tiltCorrection;
    mesh.rotation.z = rollCorrection;
  }

  public setPrimaryPanorama(metadata: PanoramaMetadata, canvas: HTMLCanvasElement): void {
    if (this.isDisposed) return;

    if (this.primaryTexture) {
      if (this.primaryTexture.image === canvas) {
        this.primaryTexture.needsUpdate = true;
        this.orientSphere(this.primaryMesh, metadata);
        this.primaryMaterial.color.setHex(0xffffff);
        return;
      }
      this.primaryTexture.dispose();
    }

    this.primaryTexture = this.createPanoramaTexture(canvas);
    this.primaryMaterial.map = this.primaryTexture;
    this.primaryMaterial.color.setHex(0xffffff);
    this.primaryMaterial.needsUpdate = true;
    this.orientSphere(this.primaryMesh, metadata);

    // Hide incoming layer once committed
    this.incomingMesh.visible = false;
    this.incomingMaterial.opacity = 0;
    if (this.incomingTexture) {
      this.incomingTexture.dispose();
      this.incomingTexture = null;
      this.incomingMaterial.map = null;
    }
  }

  public setTransitionBlend(
    incomingMetadata: PanoramaMetadata,
    incomingCanvas: HTMLCanvasElement,
    blendProgress: number,
  ): void {
    if (this.isDisposed) return;

    if (!this.incomingTexture || this.incomingTexture.image !== incomingCanvas) {
      if (this.incomingTexture) {
        this.incomingTexture.dispose();
      }
      this.incomingTexture = this.createPanoramaTexture(incomingCanvas);
      this.incomingMaterial.map = this.incomingTexture;
      this.incomingMaterial.needsUpdate = true;
    }

    this.orientSphere(this.incomingMesh, incomingMetadata);
    this.incomingMesh.visible = true;
    this.incomingMaterial.opacity = Math.max(0, Math.min(1, blendProgress));

    // Gentle forward scale zoom cue on outgoing sphere during crossfade
    const zoomScale = 1 + blendProgress * 0.045;
    this.primaryMesh.scale.setScalar(zoomScale);

    if (blendProgress >= 1) {
      this.primaryMesh.scale.setScalar(1);
      this.setPrimaryPanorama(incomingMetadata, incomingCanvas);
    }
  }

  /**
   * Renders clickable 3D road chevrons at the exact real bearings returned by
   * Google Street View metadata.links. Never fabricates connections.
   */
  public setRoadMarkers(edges: PanoramaEdge[], activeEdgeId: string | null): void {
    if (this.isDisposed) return;

    // Dispose old marker materials cleanly
    for (const mesh of this.clickableMeshes) {
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => m.dispose());
      } else {
        mat.dispose();
      }
    }
    this.clickableMeshes.length = 0;
    while (this.markerGroup.children.length > 0) {
      this.markerGroup.remove(this.markerGroup.children[0]);
    }

    for (const edge of edges) {
      const isPrimary = edge.destinationPanoId === activeEdgeId;
      const isHovered = edge.destinationPanoId === this.hoveredEdgeId;
      const rad = degToRad(edge.heading);

      // World compass direction: North = -Z, East = +X
      const x = Math.sin(rad) * MARKER_RING_RADIUS;
      const z = -Math.cos(rad) * MARKER_RING_RADIUS;
      const y = -3.4;

      const material = new THREE.MeshBasicMaterial({
        color: isPrimary ? 0xf59e0b : isHovered ? 0x38bdf8 : 0xe2e8f0,
        transparent: true,
        opacity: isPrimary ? 0.92 : isHovered ? 0.85 : 0.52,
        depthWrite: false,
      });

      const chevron = new THREE.Mesh(this.chevronGeometry, material);
      chevron.position.set(x, y, z);
      // Point chevron away from camera down the road bearing
      chevron.rotation.y = -rad;
      chevron.scale.setScalar(isPrimary ? 1.15 : 0.92);
      chevron.userData = { edge };
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
      this.afterDraw(this.tick);
    } else {
      this.frameHandle = requestAnimationFrame(this.tick);
    }
  };

  /**
   * Software-WebGL frame pacing using WebGL2 fenceSync so headless/CPU renderers
   * never starve the main thread or freeze UI interactions.
   */
  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext();
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (!this.isRunning || this.isDisposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (status === gl.UNSIGNALED) {
          this.frameHandle = window.setTimeout(poll, 8);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameHandle = window.setTimeout(cb, 80);
        }
      };
      this.frameHandle = window.setTimeout(poll, 8);
    } else {
      this.frameHandle = window.setTimeout(cb, 80);
    }
  }

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

  private updatePointerNdc(event: MouseEvent | PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private readonly handleCanvasClick = (event: MouseEvent): void => {
    if (this.cameraController.wasRecentDrag() || this.clickableMeshes.length === 0) {
      return;
    }
    this.updatePointerNdc(event);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickableMeshes, false);
    if (hits.length > 0) {
      const edge = hits[0].object.userData?.edge as PanoramaEdge | undefined;
      if (edge) {
        this.callbacks.onRoadMarkerClick?.(edge);
      }
    }
  };

  private readonly handleCanvasPointerMove = (event: PointerEvent): void => {
    if (this.clickableMeshes.length === 0) return;
    const now = performance.now();
    if (now - this.lastRaycastMs < 60) return;
    this.lastRaycastMs = now;

    this.updatePointerNdc(event);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickableMeshes, false);
    const hitEdge = (hits[0]?.object.userData?.edge as PanoramaEdge | undefined) ?? null;
    const nextHoverId = hitEdge?.destinationPanoId ?? null;

    if (nextHoverId !== this.hoveredEdgeId) {
      this.hoveredEdgeId = nextHoverId;
      this.renderer.domElement.style.cursor = nextHoverId ? 'pointer' : 'grab';
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
    dom.removeEventListener('pointermove', this.handleCanvasPointerMove);
    dom.removeEventListener('webglcontextlost', this.handleContextLost);
    dom.removeEventListener('webglcontextrestored', this.handleContextRestored);

    this.primaryTexture?.dispose();
    this.incomingTexture?.dispose();
    this.primaryMaterial.dispose();
    this.incomingMaterial.dispose();
    this.sphereGeometry.dispose();
    this.chevronGeometry.dispose();

    for (const mesh of this.clickableMeshes) {
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => m.dispose());
      } else {
        mat.dispose();
      }
    }
    this.clickableMeshes.length = 0;

    this.renderer.dispose();
    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}
