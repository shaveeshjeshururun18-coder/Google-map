import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeviceLocationService } from '../../services/DeviceLocationService';
import { CarController } from '../../streetViewEngine/driving/CarController';
import {
  calculateAngularDifference,
  classifyRelativeDirection,
  formatHeading,
  normalizeHeading,
} from '../../streetViewEngine/navigation/DirectionCalculator';
import { analyzeJunction } from '../../streetViewEngine/navigation/JunctionDetector';
import { extractValidLinks } from '../../streetViewEngine/navigation/PanoramaLinks';
import { RouteController } from '../../streetViewEngine/navigation/RouteController';
import { LoadingMonitor } from '../../streetViewEngine/performance/LoadingMonitor';
import { MemoryManager } from '../../streetViewEngine/performance/MemoryManager';
import { RequestScheduler } from '../../streetViewEngine/performance/RequestScheduler';
import { GoogleStreetViewProvider } from '../../streetViewEngine/providers/GoogleStreetViewProvider';
import { LicensedPanoramaProvider } from '../../streetViewEngine/providers/LicensedPanoramaProvider';
import {
  computeGlideFrame,
  CONTINUOUS_GLIDE_SPEC,
  smootherstep,
} from '../../streetViewEngine/rendering/ContinuousGlide';
import { DoubleBuffer } from '../../streetViewEngine/rendering/DoubleBuffer';
import { INSTANT_SWAP_SPEC } from '../../streetViewEngine/rendering/InstantSwap';
import type { PanoramaMetadata, ValidatedLink } from '../../streetViewEngine/types';

function makeMeta(
  panoId: string,
  lat: number,
  lng: number,
  links: Array<{ panoId: string; heading: number; text?: string }>,
  streetName = 'Main St',
): PanoramaMetadata {
  return {
    panoId,
    lat,
    lng,
    imageHeight: 6656,
    imageWidth: 13312,
    tileHeight: 512,
    tileWidth: 512,
    heading: links[0]?.heading ?? 0,
    imageryType: 'outdoor',
    copyright: '© Google',
    reportProblemLink: '',
    links,
    streetName,
    formattedLocation: streetName,
  };
}

describe('Street View Driving Engine — Continuous Optical-Flow Glide', () => {
  it('guarantees C-infinity scale & log-velocity continuity across panorama handoffs (forward & reverse)', () => {
    const startF = computeGlideFrame({ progress: 0, gear: 'D', isBufferBReady: true });
    const midF = computeGlideFrame({ progress: 0.5, gear: 'D', isBufferBReady: true });
    const endF = computeGlideFrame({ progress: 1, gear: 'D', isBufferBReady: true });

    // Forward: Buffer B ends at exact starting scale of next Buffer A (r = 1.26), always >= 1.0 (zero borders)
    assert.equal(startF.displayedScale, CONTINUOUS_GLIDE_SPEC.scaleRatio);
    assert.equal(startF.stagingScale, 1);
    assert.equal(startF.displayedOpacity, 1);
    assert.ok(Math.abs(endF.stagingScale - startF.displayedScale) < 1e-9);
    assert.equal(endF.displayedOpacity, 0);
    assert.equal(endF.stagingOpacity, 1);

    // Equal logarithmic optical-flow velocity: ln(mid/start) === ln(end/mid) for BOTH A and B
    const logRateA1 = Math.log(midF.displayedScale / startF.displayedScale);
    const logRateA2 = Math.log(endF.displayedScale / midF.displayedScale);
    const logRateB1 = Math.log(midF.stagingScale / startF.stagingScale);
    const logRateB2 = Math.log(endF.stagingScale / midF.stagingScale);
    assert.ok(Math.abs(logRateA1 - logRateA2) < 1e-9);
    assert.ok(Math.abs(logRateB1 - logRateB2) < 1e-9);
    assert.ok(Math.abs(logRateA1 - logRateB1) < 1e-9);

    // Reverse: Buffer B converges cleanly to r = 1.26 and never drops below 1.0
    const startR = computeGlideFrame({ progress: 0, gear: 'R', isBufferBReady: true });
    const endR = computeGlideFrame({ progress: 1, gear: 'R', isBufferBReady: true });
    assert.ok(Math.abs(endR.stagingScale - startR.displayedScale) < 1e-9);
    assert.ok(endR.displayedScale >= 1 - 1e-9);
    assert.equal(endR.displayedOpacity, 0);
  });

  it('never dissolves into an unpainted Buffer B (zero flashes on slow network)', () => {
    const unready = computeGlideFrame({ progress: 0.85, gear: 'D', isBufferBReady: false });
    assert.equal(unready.displayedOpacity, 1);
    assert.equal(unready.blendAlpha, 0);
    assert.equal(unready.isCushioning, true);
    assert.ok(unready.progress <= CONTINUOUS_GLIDE_SPEC.unreadyCushionProgress + 1e-9);
    assert.equal(smootherstep(0, 1, 0), 0);
    assert.equal(smootherstep(0, 1, 0.5), 0.5);
    assert.equal(smootherstep(0, 1, 1), 1);
  });
});

describe('Street View Driving Engine — Zero-Transition Double Buffer', () => {
  it('enforces 0ms transition with fade and interpolation completely disabled', () => {
    assert.equal(INSTANT_SWAP_SPEC.transitionDurationMs, 0);
    assert.equal(INSTANT_SWAP_SPEC.fadeEnabled, false);
    assert.equal(INSTANT_SWAP_SPEC.interpolationEnabled, false);
  });

  it('keeps Buffer A displayed while Buffer B prepares and prevents unready flashes', () => {
    const buf = new DoubleBuffer<string>();
    const metaA = makeMeta('pano-A', 37.42, -122.08, [{ panoId: 'pano-B', heading: 90 }]);
    const metaB = makeMeta('pano-B', 37.42, -122.0799, [{ panoId: 'pano-C', heading: 90 }]);

    buf.setInitialDisplayed(metaA, 'TEX_A');
    assert.equal(buf.getDisplayed().id, 'A');
    assert.equal(buf.getDisplayed().panoId, 'pano-A');
    assert.equal(buf.getSwapCount(), 0);

    // Start preparing pano-B in Buffer B
    buf.beginPrepare('pano-B');
    assert.equal(buf.getDisplayed().panoId, 'pano-A');
    assert.equal(buf.getStaging().id, 'B');
    assert.equal(buf.getStaging().status, 'preparing');
    assert.equal(buf.isStagingReadyFor('pano-B'), false);

    // Attempting to swap while Buffer B is still decoding MUST NOT swap (prevents loading flash)
    const blocked = buf.commitSwap('pano-B');
    assert.equal(blocked.swapped, false);
    assert.equal(buf.getDisplayed().panoId, 'pano-A');
    assert.equal(buf.getSwapCount(), 0);

    // Stale ready callback for a different pano must be ignored
    const metaStale = makeMeta('pano-OLD', 37.42, -122.081, []);
    assert.equal(buf.markStagingReady(metaStale, 'TEX_OLD'), false);
    assert.equal(buf.isStagingReadyFor('pano-B'), false);

    // Complete decoding in Buffer B -> atomic 0ms flip
    assert.equal(buf.markStagingReady(metaB, 'TEX_B'), true);
    assert.equal(buf.isStagingReadyFor('pano-B'), true);

    const swapped = buf.commitSwap('pano-B');
    assert.equal(swapped.swapped, true);
    assert.equal(swapped.displayed.id, 'B');
    assert.equal(swapped.displayed.panoId, 'pano-B');
    assert.equal(swapped.displayed.payload, 'TEX_B');
    assert.equal(swapped.evictedPayload, 'TEX_A');
    assert.equal(swapped.staging.id, 'A');
    assert.equal(swapped.staging.status, 'empty');
    assert.equal(buf.getSwapCount(), 1);
  });

  it('tracks LoadingMonitor snapshots without transition duration', () => {
    const monitor = new LoadingMonitor();
    monitor.markInitialDisplay('A', 'pano-1');
    monitor.markPreparing('B', 'pano-2');
    assert.equal(monitor.getSnapshot().stagingStatus, 'preparing');
    monitor.markReady('B', 'pano-2');
    assert.equal(monitor.getSnapshot().stagingStatus, 'ready');
    monitor.markSwapped('B', 'pano-2', 'A');
    const snap = monitor.getSnapshot();
    assert.equal(snap.displayedBuffer, 'B');
    assert.equal(snap.displayedPanoId, 'pano-2');
    assert.equal(snap.swapCount, 1);
    assert.equal(snap.transitionDurationMs, 0);
  });
});

describe('Street View Driving Engine — Intelligent Navigation & Junction Detection', () => {
  it('computes shortest signed angular differences and relative directions accurately', () => {
    assert.equal(normalizeHeading(-10), 350);
    assert.equal(calculateAngularDifference(355, 5), 10);
    assert.equal(calculateAngularDifference(5, 355), -10);
    assert.equal(calculateAngularDifference(0, 90), 90);
    assert.equal(calculateAngularDifference(0, 270), -90);
    assert.equal(calculateAngularDifference(0, 180), 180);

    assert.equal(classifyRelativeDirection(90, 95), 'forward');
    assert.equal(classifyRelativeDirection(90, 0), 'left');
    assert.equal(classifyRelativeDirection(90, 180), 'right');
    assert.equal(classifyRelativeDirection(90, 270), 'reverse');
    assert.equal(formatHeading(0), '000° N');
    assert.equal(formatHeading(90), '090° E');
  });

  it('classifies a 4-way intersection into forward, left, right, and reverse choices', () => {
    const links: ValidatedLink[] = [
      { sourcePanoId: 'p0', destinationPanoId: 'p-north', heading: 2, text: 'North Ave', distanceMeters: 10, distanceEstimated: true },
      { sourcePanoId: 'p0', destinationPanoId: 'p-east', heading: 91, text: 'East St', distanceMeters: 10, distanceEstimated: true },
      { sourcePanoId: 'p0', destinationPanoId: 'p-south', heading: 182, text: 'South Ave', distanceMeters: 10, distanceEstimated: true },
      { sourcePanoId: 'p0', destinationPanoId: 'p-west', heading: 268, text: 'West St', distanceMeters: 10, distanceEstimated: true },
    ];

    const summary = analyzeJunction(links, 0);
    assert.equal(summary.kind, 'intersection');
    assert.equal(summary.isDeadEnd, false);
    assert.equal(summary.forward?.link.destinationPanoId, 'p-north');
    assert.equal(summary.right?.link.destinationPanoId, 'p-east');
    assert.equal(summary.reverse?.link.destinationPanoId, 'p-south');
    assert.equal(summary.left?.link.destinationPanoId, 'p-west');
  });

  it('detects dead-ends and deduplicates self/duplicate links in RouteController', () => {
    const route = new RouteController();
    const deadMeta = makeMeta('p-dead', 37.42, -122.08, [
      { panoId: 'p-dead', heading: 90 }, // self link ignored
    ]);
    const valid = extractValidLinks(deadMeta);
    assert.equal(valid.length, 0);

    route.setCurrentPanorama(deadMeta, 90);
    const junction = route.getJunction(90);
    assert.equal(junction.kind, 'dead-end');
    assert.equal(junction.isDeadEnd, true);

    // Now test Haversine measured distance updating when neighbour metadata arrives
    const p1 = makeMeta('p1', 37.4200, -122.0800, [
      { panoId: 'p2', heading: 90, text: 'Shoreline' },
      { panoId: 'p2', heading: 90, text: 'Duplicate' },
    ]);
    const p2 = makeMeta('p2', 37.4200, -122.0799, [{ panoId: 'p1', heading: 270 }]);
    route.setCurrentPanorama(p1, 90);
    assert.equal(route.getLinksForPano('p1').length, 1);
    assert.equal(route.getLinksForPano('p1')[0].distanceEstimated, true);

    route.registerMetadata(p2);
    const updatedLink = route.getLinksForPano('p1')[0];
    assert.equal(updatedLink.distanceEstimated, false);
    assert.ok(updatedLink.distanceMeters > 5 && updatedLink.distanceMeters < 15);
  });
});

describe('Street View Driving Engine — Slow-Glide Virtual Car Controller', () => {
  it('glides slowly at calm pace, cushions unready Buffer B, and hands off smoothly when ready', () => {
    const route = new RouteController();
    const p1 = makeMeta('p1', 37.42, -122.08, [
      { panoId: 'p2', heading: 90, text: 'Charleston Rd' },
      { panoId: 'p0', heading: 270, text: 'Charleston Rd' },
    ]);
    route.setCurrentPanorama(p1, 90);

    const prepared: string[] = [];
    const swapped: string[] = [];
    const car = new CarController(route, {
      onPrepareNextLink: (link) => prepared.push(link.destinationPanoId),
      onCommitInstantSwap: (link) => swapped.push(link.destinationPanoId),
    });
    car.setCurrentPanorama('p1', 90);
    assert.deepEqual(prepared, ['p2']);
    assert.equal(car.getPace(), 'slow');

    // Hold accelerate while Buffer B is NOT ready -> must cushion cleanly and NOT hand off early
    car.setInput('accelerate', true);
    for (let i = 0; i < 40; i += 1) {
      car.step(0.1, false);
    }
    assert.equal(swapped.length, 0);
    assert.ok(car.getTelemetry().progressToNext <= CONTINUOUS_GLIDE_SPEC.unreadyCushionProgress + 0.01);
    assert.ok(car.getTelemetry().speedKmh <= 14.1);

    // Once Buffer B is ready, glides smoothly to 100% and hands off seamlessly
    for (let i = 0; i < 40 && swapped.length === 0; i += 1) {
      car.step(0.1, true);
    }
    assert.deepEqual(swapped, ['p2']);
  });

  it('supports Walk / Slow / Cruise pace presets and Reverse gear', () => {
    const route = new RouteController();
    const p1 = makeMeta('p1', 37.42, -122.08, [
      { panoId: 'p0', heading: 270, text: 'Back Road' },
    ]);
    route.setCurrentPanorama(p1, 90);

    let deadEnds = 0;
    const car = new CarController(route, {
      onDeadEndReached: () => {
        deadEnds += 1;
      },
    });
    car.setCurrentPanorama('p1', 90);

    car.setPace('walk');
    assert.equal(car.getTelemetry().maxSpeedKmh, 8);
    car.setPace('cruise');
    assert.equal(car.getTelemetry().maxSpeedKmh, 24);
    car.setPace('slow');
    assert.equal(car.getTelemetry().maxSpeedKmh, 14);

    // Forward is blocked (only link is at 270° behind us)
    car.setInput('accelerate', true);
    car.step(0.1, true);
    assert.equal(deadEnds, 1);

    // Switch to Reverse -> resolves link at 270° cleanly!
    car.toggleReverseGear();
    assert.equal(car.getTelemetry().gear, 'R');
    assert.equal(car.getTelemetry().targetLink?.destinationPanoId, 'p0');
  });
});

describe('Street View Driving Engine — Provider Independence & Policy Compliance', () => {
  it('enforces Google Street View no-bulk-preload and no-persistent-cache policy', () => {
    const googleProvider = new GoogleStreetViewProvider();
    assert.equal(googleProvider.policy.allowMultiHopPreload, false);
    assert.equal(googleProvider.policy.allowPersistentImageCache, false);
    assert.equal(googleProvider.policy.allowSingleNextPrepare, true);

    const scheduler = new RequestScheduler(googleProvider.policy);
    assert.equal(scheduler.canMultiHopPreload(), false);
    assert.equal(scheduler.canPrepareNext(), true);

    let disposedCount = 0;
    const mem = new MemoryManager<{ dispose: () => void }>(googleProvider.policy, 10);
    assert.equal(mem.isCachingEnabled(), false);
    mem.set('k1', { dispose: () => { disposedCount += 1; } });
    assert.equal(mem.size(), 0);
    assert.equal(mem.get('k1'), null);
    assert.equal(disposedCount, 1);
  });

  it('allows multi-hop preload and bounded LRU caching for independently licensed datasets', async () => {
    const licensed = new LicensedPanoramaProvider([
      {
        panoId: 'lic-1',
        lat: 37.42,
        lng: -122.08,
        heading: 90,
        streetName: 'Test Track',
        imageUrl: 'https://example.invalid/pano1.jpg',
        copyright: '© Licensed Fleet',
        links: [{ panoId: 'lic-2', heading: 90 }],
      },
    ]);

    assert.equal(licensed.policy.allowMultiHopPreload, true);
    assert.equal(licensed.policy.allowPersistentImageCache, true);

    const meta = await licensed.fetchMetadataById('lic-1');
    assert.equal(meta.panoId, 'lic-1');
    assert.equal(meta.streetName, 'Test Track');

    let evicted = 0;
    const mem = new MemoryManager<{ id: string; dispose: () => void }>(licensed.policy, 2);
    assert.equal(mem.isCachingEnabled(), true);
    mem.set('a', { id: 'a', dispose: () => { evicted += 1; } });
    mem.set('b', { id: 'b', dispose: () => { evicted += 1; } });
    mem.set('c', { id: 'c', dispose: () => { evicted += 1; } });
    assert.equal(mem.size(), 2);
    assert.equal(mem.get('a'), null);
    assert.equal(mem.get('c')?.id, 'c');
    assert.equal(evicted, 1);
  });
});

describe('Street View Driving Engine — Resilient DeviceLocationService', () => {
  it('resolves browser high-accuracy GPS when available', async () => {
    const svc = new DeviceLocationService({
      geolocation: {
        getCurrentPosition(success) {
          success({ coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 12 } });
        },
      },
    });
    const loc = await svc.resolveDeviceLocation();
    assert.equal(loc.source, 'gps');
    assert.equal(loc.lat, 37.7749);
    assert.equal(loc.lng, -122.4194);
    assert.equal(loc.accuracyMeters, 12);
  });

  it('retries with low-accuracy system/Wi-Fi location when high-accuracy GPS times out', async () => {
    const calls: boolean[] = [];
    const svc = new DeviceLocationService({
      geolocation: {
        getCurrentPosition(success, error, options) {
          calls.push(Boolean(options?.enableHighAccuracy));
          if (options?.enableHighAccuracy) {
            error?.({ code: 3, message: 'Timeout' });
          } else {
            success({ coords: { latitude: 40.7128, longitude: -74.006, accuracy: 85 } });
          }
        },
      },
    });
    const loc = await svc.resolveDeviceLocation();
    assert.deepEqual(calls, [true, false]);
    assert.equal(loc.source, 'gps');
    assert.equal(loc.lat, 40.7128);
    assert.equal(loc.lng, -74.006);
  });

  it('falls back to network/IP geolocation when browser GPS is denied or blocked in iframe', async () => {
    const svc = new DeviceLocationService({
      geolocation: {
        getCurrentPosition(_success, error) {
          error?.({ code: 1, message: 'User denied Geolocation' });
        },
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('ipwho.is')) {
          return new Response(
            JSON.stringify({
              success: true,
              latitude: 37.3861,
              longitude: -122.0839,
              city: 'Mountain View',
              region: 'California',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 500 });
      }) as typeof fetch,
    });

    const loc = await svc.resolveDeviceLocation();
    assert.equal(loc.source, 'network');
    assert.equal(loc.lat, 37.3861);
    assert.equal(loc.lng, -122.0839);
    assert.equal(loc.label, 'Mountain View, California');
  });

  it('falls back to server /api/geolocation when client GeoIP endpoints are blocked', async () => {
    const svc = new DeviceLocationService({
      geolocation: null,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/geolocation') {
          return new Response(
            JSON.stringify({
              lat: 51.5074,
              lng: -0.1278,
              label: 'London, England',
              source: 'network',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error('Blocked by adblocker');
      }) as typeof fetch,
    });

    const loc = await svc.resolveDeviceLocation();
    assert.equal(loc.source, 'network');
    assert.equal(loc.lat, 51.5074);
    assert.equal(loc.lng, -0.1278);
    assert.equal(loc.label, 'London, England');
  });
});

