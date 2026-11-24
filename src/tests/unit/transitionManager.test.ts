import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PanoramaTransitionManager,
  type TransitionAssetLoader,
} from '../../engine/PanoramaTransitionManager';
import type { PanoramaMetadata, TransitionState } from '../../types/streetview';

function makeMeta(panoId: string, streetName: string): PanoramaMetadata {
  return {
    panoId,
    lat: 37.42,
    lng: -122.08,
    imageWidth: 13312,
    imageHeight: 6656,
    tileWidth: 512,
    tileHeight: 512,
    heading: 90,
    copyright: '© 2024 Google',
    reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report',
    links: [],
    streetName,
    formattedLocation: streetName,
  };
}

function makeFakeCanvas(): HTMLCanvasElement {
  return { width: 512, height: 256 } as unknown as HTMLCanvasElement;
}

test('PanoramaTransitionManager cancels obsolete in-flight requests when a newer destination is chosen', async () => {
  let abortedCount = 0;

  const loader: TransitionAssetLoader = {
    async fetchMetadataByPanoId(panoId, signal) {
      await new Promise<void>((resolve, reject) => {
        const delay = panoId === 'slow-pano' ? 80 : 10;
        const timer = setTimeout(() => resolve(), delay);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          abortedCount += 1;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      return makeMeta(panoId, `Street ${panoId}`);
    },
    async fetchMetadataByLocation() {
      return makeMeta('loc-pano', 'Loc St');
    },
    async loadPanoramaCanvas() {
      return { canvas: makeFakeCanvas(), zoom: 2 };
    },
  };

  const manager = new PanoramaTransitionManager(loader, {}, 0);
  const firstPromise = manager.transitionToPanoId('slow-pano', 'balanced');
  const secondPromise = manager.transitionToPanoId('fast-pano', 'balanced');

  const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(firstResult, null);
  assert.equal(secondResult?.metadata.panoId, 'fast-pano');
  assert.equal(manager.getActiveMetadata()?.panoId, 'fast-pano');
  assert.equal(abortedCount, 1);
});

test('PanoramaTransitionManager uses preloaded asset immediately and recovers gracefully from errors', async () => {
  let metadataFetchCalls = 0;
  const phases: TransitionState['phase'][] = [];

  const loader: TransitionAssetLoader = {
    async fetchMetadataByPanoId(panoId) {
      metadataFetchCalls += 1;
      if (panoId === 'broken-pano') {
        throw new Error('Upstream tile server failed');
      }
      return makeMeta(panoId, `Road ${panoId}`);
    },
    async fetchMetadataByLocation() {
      return makeMeta('start-pano', 'Start Rd');
    },
    async loadPanoramaCanvas() {
      return { canvas: makeFakeCanvas(), zoom: 2 };
    },
  };

  const manager = new PanoramaTransitionManager(
    loader,
    { onStateChange: (s) => phases.push(s.phase) },
    0,
  );

  // Initial load
  await manager.transitionToPanoId('start-pano', 'balanced');
  assert.equal(manager.getActiveMetadata()?.panoId, 'start-pano');

  // Preload next panorama
  await manager.preloadByPanoId('next-pano', 'balanced');
  const callsAfterPreload = metadataFetchCalls;

  // Transitioning to preloaded panorama skips redundant metadata/tile fetch
  const asset = await manager.transitionToPanoId('next-pano', 'balanced');
  assert.equal(asset?.metadata.panoId, 'next-pano');
  assert.equal(metadataFetchCalls, callsAfterPreload);
  assert.ok(phases.includes('blending'));

  // Failed transition preserves previously active panorama instead of blacking out
  await assert.rejects(() => manager.transitionToPanoId('broken-pano', 'balanced'));
  assert.equal(manager.getActiveMetadata()?.panoId, 'next-pano');
  assert.equal(manager.getState().phase, 'error');
});
