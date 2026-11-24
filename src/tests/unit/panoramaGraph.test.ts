import test from 'node:test';
import assert from 'node:assert/strict';
import { PanoramaGraph } from '../../navigation/PanoramaGraph';
import type { PanoramaMetadata } from '../../types/streetview';

function makePano(overrides: Partial<PanoramaMetadata> & { panoId: string }): PanoramaMetadata {
  return {
    panoId: overrides.panoId,
    lat: overrides.lat ?? 37.420864,
    lng: overrides.lng ?? -122.084465,
    imageWidth: 13312,
    imageHeight: 6656,
    tileWidth: 512,
    tileHeight: 512,
    heading: overrides.heading ?? 90,
    copyright: '© 2024 Google',
    reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report',
    links: overrides.links ?? [],
    streetName: overrides.streetName ?? 'Charleston Rd',
    formattedLocation: overrides.formattedLocation ?? 'Charleston Rd, Mountain View, CA',
  };
}

test('PanoramaGraph creates nodes, deduplicates edges, and ignores self-links', () => {
  const graph = new PanoramaGraph();
  graph.addNode(
    makePano({
      panoId: 'pano-a',
      links: [
        { panoId: 'pano-b', heading: 90, text: 'Charleston Rd' },
        { panoId: 'pano-b', heading: 90, text: 'Charleston Rd' }, // duplicate
        { panoId: 'pano-a', heading: 0, text: 'Self loop' }, // invalid self-link
        { panoId: 'pano-c', heading: 270, text: 'Charleston Rd' },
      ],
    }),
  );

  assert.equal(graph.getNodeCount(), 1);
  assert.equal(graph.getEdgeCount(), 2);
  const edges = graph.getEdges('pano-a');
  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.destinationPanoId === 'pano-b'));
  assert.ok(edges.some((e) => e.destinationPanoId === 'pano-c'));
});

test('PanoramaGraph marks edge distance as estimated until destination coordinates exist, then computes real Haversine distance', () => {
  const graph = new PanoramaGraph();
  graph.addNode(
    makePano({
      panoId: 'pano-1',
      lat: 37.420864,
      lng: -122.084465,
      links: [{ panoId: 'pano-2', heading: 0, text: 'North St' }],
    }),
  );

  const initialEdge = graph.getEdge('pano-1', 'pano-2');
  assert.ok(initialEdge);
  assert.equal(initialEdge.distanceEstimated, true);
  assert.equal(initialEdge.distanceMeters, 12);

  // Add destination ~15m north
  graph.addNode(
    makePano({
      panoId: 'pano-2',
      lat: 37.420999,
      lng: -122.084465,
      links: [{ panoId: 'pano-1', heading: 180, text: 'North St' }],
    }),
  );

  const updatedEdge = graph.getEdge('pano-1', 'pano-2');
  assert.ok(updatedEdge);
  assert.equal(updatedEdge.distanceEstimated, false);
  assert.ok(
    updatedEdge.distanceMeters > 13 && updatedEdge.distanceMeters < 17,
    `Expected ~15m real distance, got ${updatedEdge.distanceMeters}`,
  );
});
