import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationManager } from '../../navigation/NavigationManager';
import type { PanoramaMetadata } from '../../types/streetview';

function createIntersectionPano(): PanoramaMetadata {
  return {
    panoId: 'intersection-1',
    lat: 37.421,
    lng: -122.084,
    imageWidth: 13312,
    imageHeight: 6656,
    tileWidth: 512,
    tileHeight: 512,
    heading: 0,
    copyright: '© 2024 Google',
    reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report',
    streetName: 'Main Ave',
    formattedLocation: 'Main Ave, Mountain View',
    // Real 3-way T-intersection (East, West, North — no South road)
    links: [
      { panoId: 'north-1', heading: 4, text: 'Main Ave N' },
      { panoId: 'east-1', heading: 92, text: 'Cross St E' },
      { panoId: 'west-1', heading: 268, text: 'Cross St W' },
    ],
  };
}

test('NavigationManager discovers neighbours and resolves forward, left, right, and reverse links accurately', () => {
  const nav = new NavigationManager();
  const intersection = createIntersectionPano();
  const edges = nav.discoverNeighbours(intersection);
  assert.equal(edges.length, 3);

  // Facing North (0°): North is forward, East is right, West is left, no South reverse
  assert.equal(nav.findForwardNeighbour('intersection-1', 0)?.edge.destinationPanoId, 'north-1');
  assert.equal(nav.findRightNeighbour('intersection-1', 0)?.edge.destinationPanoId, 'east-1');
  assert.equal(nav.findLeftNeighbour('intersection-1', 0)?.edge.destinationPanoId, 'west-1');
  assert.equal(nav.findReverseNeighbour('intersection-1', 0), null);

  // Facing East (90°): East is forward, North is left, West is reverse, no right turn
  assert.equal(nav.findForwardNeighbour('intersection-1', 90)?.edge.destinationPanoId, 'east-1');
  assert.equal(nav.findLeftNeighbour('intersection-1', 90)?.edge.destinationPanoId, 'north-1');
  assert.equal(nav.findReverseNeighbour('intersection-1', 90)?.edge.destinationPanoId, 'west-1');
  assert.equal(nav.findRightNeighbour('intersection-1', 90), null);
});

test('NavigationManager detects dead-ends and intersections accurately', () => {
  const nav = new NavigationManager();
  nav.discoverNeighbours(createIntersectionPano());

  const tStatus = nav.detectDeadEnds('intersection-1', 0);
  assert.equal(tStatus.isIntersection, true);
  assert.equal(tStatus.isDeadEnd, false);
  assert.equal(tStatus.isForwardBlocked, false);

  // Facing South at this T-junction has no forward road
  const blockedStatus = nav.detectDeadEnds('intersection-1', 180);
  assert.equal(blockedStatus.isForwardBlocked, true);

  // Cul-de-sac with only 1 link behind the driver
  nav.discoverNeighbours({
    ...createIntersectionPano(),
    panoId: 'cul-de-sac',
    links: [{ panoId: 'intersection-1', heading: 180, text: 'Main Ave S' }],
  });
  const deadEnd = nav.detectDeadEnds('cul-de-sac', 0);
  assert.equal(deadEnd.isDeadEnd, true);
  assert.equal(deadEnd.availableCount, 1);
});

test('NavigationManager maintains ordered navigation history with previous/next lookups', () => {
  const nav = new NavigationManager();
  const p1 = createIntersectionPano();
  const p2: PanoramaMetadata = { ...p1, panoId: 'north-1', lat: 37.4211, streetName: 'Main Ave N' };

  nav.maintainNavigationHistory(p1, 0);
  nav.maintainNavigationHistory(p2, 4);

  assert.equal(nav.getHistory().length, 2);
  assert.equal(nav.getCurrentHistoryEntry()?.panoId, 'north-1');
  assert.equal(nav.getPreviousHistoryEntry()?.panoId, 'intersection-1');
});
