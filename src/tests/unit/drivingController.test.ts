import test from 'node:test';
import assert from 'node:assert/strict';
import { DrivingController } from '../../engine/DrivingController';
import { NavigationManager } from '../../navigation/NavigationManager';
import type { GearMode, PanoramaEdge, PanoramaMetadata } from '../../types/streetview';

function setupRoadCorridor() {
  const nav = new NavigationManager();
  const p1: PanoramaMetadata = {
    panoId: 'road-1',
    lat: 37.4208,
    lng: -122.0844,
    imageWidth: 13312,
    imageHeight: 6656,
    tileWidth: 512,
    tileHeight: 512,
    heading: 90,
    copyright: '© 2024 Google',
    reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report',
    streetName: 'Charleston Rd',
    formattedLocation: 'Charleston Rd, Mountain View',
    links: [
      { panoId: 'road-2', heading: 90, text: 'Charleston Rd East' },
      { panoId: 'road-0', heading: 270, text: 'Charleston Rd West' },
    ],
  };
  nav.discoverNeighbours(p1);
  return nav;
}

test('DrivingController accelerates, brakes, clamps large timesteps, and triggers preload and advance', () => {
  const nav = setupRoadCorridor();
  const preloaded: string[] = [];
  const advanced: Array<{ panoId: string; gear: GearMode }> = [];

  const controller = new DrivingController(nav, {
    onPreloadEdge: (edge: PanoramaEdge) => preloaded.push(edge.destinationPanoId),
    onAdvanceToEdge: (edge: PanoramaEdge, gear: GearMode) =>
      advanced.push({ panoId: edge.destinationPanoId, gear }),
  });

  controller.setCurrentPanorama('road-1', 90);
  controller.setInput('accelerate', true);

  // Verify huge dt (e.g. 10 seconds tab sleep) is safely clamped to maxTimestepSeconds (0.1s)
  const clampedStep = controller.step(10);
  assert.ok(clampedStep.speedMs <= 2.1, `Expected clamped acceleration, got ${clampedStep.speedMs} m/s`);

  // Step forward in 0.1s increments until crossing the street segment
  for (let i = 0; i < 30; i += 1) {
    controller.step(0.1);
  }

  assert.ok(preloaded.includes('road-2'), 'Expected next panorama to preload before arrival');
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].panoId, 'road-2');
  assert.equal(advanced[0].gear, 'D');

  // Verify braking reduces speed quickly to 0
  controller.setInput('accelerate', false);
  controller.setInput('brake', true);
  for (let i = 0; i < 20; i += 1) {
    controller.step(0.1);
  }
  assert.equal(controller.getTelemetry().speedKmh, 0);
});

test('DrivingController supports Reverse gear navigation toward rear connected panorama', () => {
  const nav = setupRoadCorridor();
  const advanced: Array<{ panoId: string; gear: GearMode }> = [];

  const controller = new DrivingController(nav, {
    onAdvanceToEdge: (edge, gear) => advanced.push({ panoId: edge.destinationPanoId, gear }),
  });

  controller.setCurrentPanorama('road-1', 90); // Facing East
  assert.equal(controller.toggleReverseGear(), 'R');
  controller.setInput('accelerate', true);

  for (let i = 0; i < 30; i += 1) {
    controller.step(0.1);
  }

  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].panoId, 'road-0'); // Rear link heading 270° West
  assert.equal(advanced[0].gear, 'R');
  assert.ok(controller.getTelemetry().speedKmh <= 36.1);
});

test('DrivingController responds immediately to sudden left/right lane shifts and rapid steering', () => {
  const nav = setupRoadCorridor();
  const controller = new DrivingController(nav);
  controller.setCurrentPanorama('road-1', 90);

  // Instant left swerve via nudgeLateral (-1)
  controller.nudgeLateral(-1);
  const leftStep = controller.step(0.05);
  assert.ok(leftStep.lateralOffset < -0.2, `Expected sudden left shift, got ${leftStep.lateralOffset}`);

  // Instant right swerve via nudgeLateral (+1) reversing from left lane
  controller.nudgeLateral(1);
  controller.step(0.06);
  const rightStep = controller.step(0.06);
  assert.ok(rightStep.lateralOffset > 0.2, `Expected sudden right shift, got ${rightStep.lateralOffset}`);

  // Rapid steering via steerRight input (progressive weave -> corner ramp)
  const startHeading = controller.getTelemetry().heading;
  controller.setInput('steerRight', true);
  for (let i = 0; i < 6; i += 1) {
    controller.step(0.05);
  }
  const afterSteer = controller.getTelemetry();
  assert.ok(afterSteer.heading > startHeading + 20, `Expected responsive heading turn, got ${afterSteer.heading}`);
  assert.ok(afterSteer.steeringAngle > 0.5, `Expected crisp steering angle, got ${afterSteer.steeringAngle}`);
});

test('DrivingController runs Cruise control, shifts virtual gears with RPM sync, and produces drift slip on high-speed swerves', () => {
  const nav = setupRoadCorridor();
  const controller = new DrivingController(nav);
  controller.setCurrentPanorama('road-1', 90);

  assert.equal(controller.toggleCruise(), true);
  let sawUpshift = false;
  for (let i = 0; i < 20; i += 1) {
    const t = controller.step(0.08);
    if (t.justShiftedGear) sawUpshift = true;
  }

  const cruising = controller.getTelemetry();
  assert.ok(cruising.cruiseEnabled);
  assert.ok(cruising.speedKmh > 65, `Expected Cruise speed > 65 km/h, got ${cruising.speedKmh}`);
  assert.ok(cruising.virtualGear >= 3, `Expected virtual gear >= 3, got ${cruising.virtualGear}`);
  assert.ok(sawUpshift, 'Expected virtual gearbox upshift pulse during acceleration');

  // Sudden swerve at cruise speed generates measurable tire drift slip
  controller.nudgeLateral(-1);
  const swerveTelemetry = controller.step(0.05);
  assert.ok(swerveTelemetry.driftIntensity > 0.3, `Expected drift slip > 0.3, got ${swerveTelemetry.driftIntensity}`);

  // Holding steerLeft while driving on a straight corridor swerves smoothly without losing the road
  controller.setInput('steerLeft', true);
  for (let i = 0; i < 15; i += 1) {
    controller.step(0.08);
  }
  const woven = controller.getTelemetry();
  assert.ok(woven.targetEdge !== null, 'Expected car to stay locked on road corridor while weaving');
  assert.ok(woven.lateralOffset < -0.7, `Expected strong left lane shift, got ${woven.lateralOffset}`);
  assert.ok(woven.speedKmh > 60, `Expected continuous driving speed without stalling, got ${woven.speedKmh}`);
  controller.setInput('steerLeft', false);

  // Braking cancels cruise control cleanly
  controller.setInput('brake', true);
  assert.equal(controller.getTelemetry().cruiseEnabled, false);
});

test('DrivingController brakes smoothly and fires dead-end callback when accelerating into uncovered direction', () => {
  const nav = setupRoadCorridor();
  let deadEndCount = 0;
  const controller = new DrivingController(nav, {
    onDeadEndReached: () => {
      deadEndCount += 1;
    },
  });

  // Facing North (0°), perpendicular to East/West links -> no forward link
  controller.setCurrentPanorama('road-1', 0);
  controller.setInput('accelerate', true);
  const telemetry = controller.step(0.1);

  assert.equal(telemetry.targetEdge, null);
  assert.equal(telemetry.speedKmh, 0);
  assert.equal(deadEndCount, 1);
});

test('DrivingController elastically paces cold tiles and carries overshoot seamlessly across zero-gap handoffs', () => {
  const nav = setupRoadCorridor();
  const p2: PanoramaMetadata = {
    panoId: 'road-2',
    lat: 37.4208,
    lng: -122.0842,
    imageWidth: 13312,
    imageHeight: 6656,
    tileWidth: 512,
    tileHeight: 512,
    heading: 90,
    copyright: '© 2024 Google',
    reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report',
    streetName: 'Charleston Rd',
    formattedLocation: 'Charleston Rd, Mountain View',
    links: [
      { panoId: 'road-3', heading: 90, text: 'Charleston Rd East' },
      { panoId: 'road-1', heading: 270, text: 'Charleston Rd West' },
    ],
  };
  nav.discoverNeighbours(p2);

  let advances = 0;
  const controller = new DrivingController(nav, {
    onAdvanceToEdge: (edge) => {
      advances += 1;
      // Simulate 0ms synchronous ring-buffer handoff
      controller.setCurrentPanorama(edge.destinationPanoId, 90);
    },
  });

  controller.setCurrentPanorama('road-1', 90);
  controller.setInput('accelerate', true);

  // Drive while next tile is still cold (isNextPanoReady = false): should hold smoothly at 0.86..0.97 without stalling
  for (let i = 0; i < 16; i += 1) {
    controller.step(0.08, false);
  }
  const held = controller.getTelemetry();
  assert.equal(advances, 0, 'Expected elastic hold while cold tile finishes painting');
  assert.ok(held.progressToNext >= 0.86 && held.progressToNext <= 0.98, `Expected smooth hold progress, got ${held.progressToNext}`);

  // The moment the tile reports ready, it advances immediately on the very next frame with zero gap
  const afterReady = controller.step(0.08, true);
  assert.equal(advances, 1, 'Expected instant handoff as soon as tile reports ready');
  assert.equal(afterReady.targetEdge?.destinationPanoId, 'road-3');
  assert.ok(afterReady.progressToNext > 0, `Expected seamless overshoot carryover > 0, got ${afterReady.progressToNext}`);
});

