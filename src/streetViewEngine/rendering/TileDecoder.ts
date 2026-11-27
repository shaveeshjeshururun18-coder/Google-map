import type { PanoramaMetadata, QualityPreset } from '../types';
import { computeTileGridSpec } from '../../utils/geo';

export interface TileFetchResult {
  canvas: HTMLCanvasElement;
  zoom: number;
}

function selectQualityZoom(
  metadata: PanoramaMetadata,
  quality: QualityPreset,
  maxTextureWidth: number,
): number {
  const desired = quality === 'fast' ? 1 : quality === 'balanced' ? 2 : 3;
  let chosen = desired;
  while (chosen > 0) {
    const spec = computeTileGridSpec(
      metadata.imageWidth,
      metadata.imageHeight,
      metadata.tileWidth,
      metadata.tileHeight,
      chosen,
    );
    if (spec.levelWidth <= maxTextureWidth) {
      return spec.zoom;
    }
    chosen -= 1;
  }
  return 0;
}

/**
 * Decodes an image Blob off the main thread when `createImageBitmap` is supported
 * so controls and camera rotation never hitch while Buffer B prepares.
 */
async function decodeBlobOffscreen(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode panorama tile image.'));
    };
    img.src = url;
  });
}

function drawDecoded(
  ctx: CanvasRenderingContext2D,
  decoded: ImageBitmap | HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  ctx.drawImage(decoded, dx, dy, dw, dh);
  if ('close' in decoded && typeof decoded.close === 'function') {
    decoded.close();
  }
}

/**
 * Non-blocking off-screen equirectangular tile assembler for tile-based Street View
 * or licensed 360° providers. Always completes assembly off-screen before handing
 * the finished canvas to DoubleBuffer (zero partial-tile flashes).
 */
export class TileDecoder {
  private readonly concurrency: number;

  constructor(concurrency = 6) {
    this.concurrency = concurrency;
  }

  public async assembleTileGrid(
    metadata: PanoramaMetadata,
    quality: QualityPreset,
    maxTextureWidth: number,
    fetchTileBlob: (z: number, x: number, y: number, signal: AbortSignal) => Promise<Blob | null>,
    signal: AbortSignal,
  ): Promise<TileFetchResult> {
    const zoom = selectQualityZoom(metadata, quality, maxTextureWidth);
    const grid = computeTileGridSpec(
      metadata.imageWidth,
      metadata.imageHeight,
      metadata.tileWidth,
      metadata.tileHeight,
      zoom,
    );

    const canvas = document.createElement('canvas');
    canvas.width = grid.levelWidth;
    canvas.height = grid.levelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable for panorama tile assembly.');
    }

    ctx.fillStyle = '#0B0E14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const coords: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < grid.tilesY; y += 1) {
      for (let x = 0; x < grid.tilesX; x += 1) {
        coords.push({ x, y });
      }
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < coords.length) {
        if (signal.aborted) return;
        const idx = cursor;
        cursor += 1;
        const { x, y } = coords[idx];
        const blob = await fetchTileBlob(grid.zoom, x, y, signal);
        if (!blob || signal.aborted) continue;

        const decoded = await decodeBlobOffscreen(blob);
        if (signal.aborted) {
          if ('close' in decoded && typeof decoded.close === 'function') decoded.close();
          return;
        }
        drawDecoded(
          ctx,
          decoded,
          x * grid.tileWidth,
          y * grid.tileHeight,
          grid.tileWidth,
          grid.tileHeight,
        );
      }
    };

    const workerCount = Math.min(this.concurrency, coords.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (signal.aborted) {
      throw new DOMException('Tile assembly aborted.', 'AbortError');
    }

    return { canvas, zoom: grid.zoom };
  }

  public async decodeSingleEquirectangularUrl(
    imageUrl: string,
    maxTextureWidth: number,
    signal: AbortSignal,
  ): Promise<TileFetchResult> {
    const res = await fetch(imageUrl, { signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch licensed panorama image (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    if (signal.aborted) {
      throw new DOMException('Panorama decode aborted.', 'AbortError');
    }

    const decoded = await decodeBlobOffscreen(blob);
    const rawW = 'width' in decoded ? decoded.width : 2048;
    const rawH = 'height' in decoded ? decoded.height : 1024;
    const scale = rawW > maxTextureWidth ? maxTextureWidth / rawW : 1;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rawW * scale));
    canvas.height = Math.max(1, Math.round(rawH * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if ('close' in decoded && typeof decoded.close === 'function') decoded.close();
      throw new Error('2D canvas context unavailable for panorama decode.');
    }

    drawDecoded(ctx, decoded, 0, 0, canvas.width, canvas.height);
    return { canvas, zoom: 2 };
  }
}
