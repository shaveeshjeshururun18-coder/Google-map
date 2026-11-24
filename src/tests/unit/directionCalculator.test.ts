import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAngularDifference,
  calculateRelativeDirection,
  formatHeading,
  getCardinalLabel,
  normalizeHeading,
} from '../../navigation/DirectionCalculator';
import { computeTileGridSpec, haversineDistanceMeters } from '../../utils/geo';

test('normalizeHeading wraps negative and >360 angles cleanly into [0, 360)', () => {
  assert.equal(normalizeHeading(0), 0);
  assert.equal(normalizeHeading(360), 0);
  assert.equal(normalizeHeading(-90), 270);
  assert.equal(normalizeHeading(450), 90);
  assert.equal(normalizeHeading(-370), 350);
});

test('calculateAngularDifference returns shortest signed angle across 0/360 seam', () => {
  assert.equal(calculateAngularDifference(350, 10), 20);
  assert.equal(calculateAngularDifference(10, 350), -20);
  assert.equal(calculateAngularDifference(90, 180), 90);
  assert.equal(calculateAngularDifference(180, 90), -90);
  assert.equal(calculateAngularDifference(0, 180), 180);
});

test('calculateRelativeDirection classifies forward, turns, and reverse accurately', () => {
  assert.equal(calculateRelativeDirection(90, 95), 'forward');
  assert.equal(calculateRelativeDirection(90, 130), 'slight-right');
  assert.equal(calculateRelativeDirection(90, 180), 'right');
  assert.equal(calculateRelativeDirection(90, 50), 'slight-left');
  assert.equal(calculateRelativeDirection(90, 0), 'left');
  assert.equal(calculateRelativeDirection(90, 270), 'reverse');
});

test('getCardinalLabel and formatHeading format compass readings consistently', () => {
  assert.equal(getCardinalLabel(0), 'N');
  assert.equal(getCardinalLabel(45), 'NE');
  assert.equal(getCardinalLabel(180), 'S');
  assert.equal(getCardinalLabel(315), 'NW');
  assert.equal(formatHeading(5), '005° N');
  assert.equal(formatHeading(270), '270° W');
});

test('computeTileGridSpec computes exact Street View equirectangular tile bounds for z=0..5', () => {
  const z0 = computeTileGridSpec(13312, 6656, 512, 512, 0);
  assert.equal(z0.maxZoom, 5);
  assert.equal(z0.tilesX, 1);
  assert.equal(z0.tilesY, 1);
  assert.equal(z0.levelWidth, 416);
  assert.equal(z0.levelHeight, 208);

  const z2 = computeTileGridSpec(13312, 6656, 512, 512, 2);
  assert.equal(z2.tilesX, 4);
  assert.equal(z2.tilesY, 2);
  assert.equal(z2.levelWidth, 1664);
  assert.equal(z2.levelHeight, 832);

  const z5 = computeTileGridSpec(13312, 6656, 512, 512, 5);
  assert.equal(z5.tilesX, 26);
  assert.equal(z5.tilesY, 13);
});

test('haversineDistanceMeters accurately measures street-scale distances', () => {
  const dist = haversineDistanceMeters(37.420864, -122.084465, 37.420954, -122.084465);
  // 0.00009 deg latitude is ~10 meters
  assert.ok(dist > 9 && dist < 11, `Expected ~10m, got ${dist}`);
});
