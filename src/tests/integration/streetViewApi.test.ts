/**
 * MOCKED API INTEGRATION TESTS
 * These tests validate the StreetViewService, PanoramaMetadataService, NavigationManager,
 * and GoogleMapsProxyService request/response contracts using deterministic mock HTTP
 * responses (clearly separated from live Google Maps Platform API calls).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleMapsProxyService } from '../../../server/services/googleMapsProxy';
import { NavigationManager } from '../../navigation/NavigationManager';
import { StreetViewApiError } from '../../services/PanoramaMetadataService';
import { StreetViewService } from '../../services/StreetViewService';

const MOCK_PANO_A = {
  panoId: 'mockPanoA_123',
  lat: 37.420864,
  lng: -122.084465,
  imageHeight: 6656,
  imageWidth: 13312,
  tileHeight: 512,
  tileWidth: 512,
  heading: 94.35,
  tilt: 88.4,
  roll: 1.2,
  imageryType: 'outdoor',
  date: '2024-03',
  copyright: '© 2024 Google',
  reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report&panoid=mockPanoA_123',
  addressComponents: [
    { longName: 'Charleston Rd', shortName: 'Charleston Rd', types: ['route'] },
    { longName: 'Mountain View', shortName: 'Mountain View', types: ['locality'] },
  ],
  links: [
    { panoId: 'mockPanoB_456', heading: 94.5, text: 'Charleston Rd' },
  ],
};

const MOCK_PANO_B = {
  ...MOCK_PANO_A,
  panoId: 'mockPanoB_456',
  lat: 37.420864,
  lng: -122.08432,
  links: [
    { panoId: 'mockPanoA_123', heading: 274.5, text: 'Charleston Rd' },
  ],
};

test('[MOCK API] StreetViewService creates session, fetches metadata, fetches tile, and navigates neighbour', async () => {
  const requestedUrls: string[] = [];

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.endsWith('/api/streetview/session')) {
      return new Response(
        JSON.stringify({
          active: true,
          expiryMs: Date.now() + 3600_000,
          tileWidth: 512,
          tileHeight: 512,
          imageFormat: 'jpeg',
          language: 'en-US',
          region: 'US',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/api/streetview/metadata') && url.includes('lat=')) {
      return new Response(JSON.stringify(MOCK_PANO_A), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/streetview/metadata') && url.includes('panoId=mockPanoB_456')) {
      return new Response(JSON.stringify(MOCK_PANO_B), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/streetview/tiles/0/0/0')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const sv = new StreetViewService(mockFetch);
  const nav = new NavigationManager();

  // 1. Create session
  const session = await sv.ensureSession();
  assert.equal(session.active, true);
  assert.equal(session.tileWidth, 512);

  // 2. Load metadata for coordinates and populate navigation graph
  const metaA = await sv.metadataService.getMetadataByLocation(37.420864, -122.084465, 50);
  assert.equal(metaA.panoId, 'mockPanoA_123');
  assert.equal(metaA.streetName, 'Charleston Rd');
  assert.equal(metaA.copyright, '© 2024 Google');

  const edges = nav.discoverNeighbours(metaA);
  assert.equal(edges.length, 1);

  // 3. Fetch tile binary payload
  const tileBlob = await sv.fetchTileBlob(metaA.panoId, 0, 0, 0);
  assert.equal(tileBlob.size, 4);

  // 4. Navigate to official connected neighbour
  const metaB = await nav.loadNeighbour(edges[0], (panoId) =>
    sv.metadataService.getMetadataByPanoId(panoId),
  );
  assert.equal(metaB.panoId, 'mockPanoB_456');
  assert.equal(nav.graph.getNodeCount(), 2);
});

test('[MOCK API] StreetViewService surfaces structured errors for 404 no-coverage and 429 quota exhaustion', async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('lat=0')) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'NO_COVERAGE',
            message: 'No Google Street View panorama is available at this location.',
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        error: {
          code: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
          isQuotaError: true,
        },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const sv = new StreetViewService(mockFetch);

  await assert.rejects(
    () => sv.metadataService.getMetadataByLocation(0, 0, 50),
    (err: unknown) => err instanceof StreetViewApiError && err.code === 'NO_COVERAGE',
  );

  await assert.rejects(
    () => sv.metadataService.getMetadataByLocation(37.4, -122.0, 50),
    (err: unknown) =>
      err instanceof StreetViewApiError &&
      err.code === 'RESOURCE_EXHAUSTED' &&
      err.isQuotaError === true,
  );
});

test('[MOCK API] GoogleMapsProxyService automatically refreshes expired session token and retries once', async () => {
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test_mock_key_value';

  let sessionCreations = 0;
  let metadataCalls = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    assert.equal(headers['X-Goog-Maps-Solution-ID'], 'gmp_mcp_codeassist_v1_aistudio');

    if (url.includes('/v1/createSession')) {
      sessionCreations += 1;
      return new Response(
        JSON.stringify({
          session: `session_token_${sessionCreations}`,
          expiry: String(Math.floor(Date.now() / 1000) + 3600),
          tileWidth: 512,
          tileHeight: 512,
          imageFormat: 'jpeg',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/v1/streetview/metadata')) {
      metadataCalls += 1;
      if (metadataCalls === 1) {
        return new Response(
          JSON.stringify({
            error: { code: 400, message: 'The session token has expired.' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      assert.ok(url.includes('session=session_token_2'));
      return new Response(JSON.stringify(MOCK_PANO_A), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected upstream URL: ${url}`);
  };

  try {
    const proxy = new GoogleMapsProxyService(mockFetch);
    const result = await proxy.getStreetViewMetadata({ lat: 37.420864, lng: -122.084465, radius: 50 });
    assert.equal(result.panoId, 'mockPanoA_123');
    assert.equal(sessionCreations, 2);
    assert.equal(metadataCalls, 2);
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_MAPS_API_KEY;
    } else {
      process.env.GOOGLE_MAPS_API_KEY = originalKey;
    }
  }
});
