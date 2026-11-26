import test from "node:test";
import assert from "node:assert/strict";
import { colorForLine } from "../src/colors.js";
import { estimateTripUpdates, haversineMeters } from "../src/estimated-vehicles.js";
import { parseEstimatedStaticFeed } from "../src/estimated-static.js";
import { decodeFeed, feedBuffer } from "./helpers.js";
import {
  BETWEEN_NOW,
  FEED_TIMESTAMP,
  ESTIMATED_BBOX,
  OUTPUT_BBOX,
  estimatedStaticZip,
  stopUpdate,
  tripEntity,
} from "./estimated-fixtures.js";

async function setup() {
  return parseEstimatedStaticFeed(estimatedStaticZip(), { bbox: ESTIMATED_BBOX });
}

function estimate(index, entities, nowMs = BETWEEN_NOW, extraOptions = {}) {
  const feed = decodeFeed(feedBuffer({ headerTimestamp: Math.floor(nowMs / 1000), entities }));
  return estimateTripUpdates(feed, index, {
    bbox: OUTPUT_BBOX,
    agencyIds: [],
    staleAfterSeconds: 90,
    nowMs,
    ...extraOptions,
  }, nowMs);
}

function closeTo(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("estimates a delayed between-stops position and emits complete vehicle metadata", async () => {
  const index = await setup();
  const result = estimate(index, [tripEntity("t-bus", {
    updates: [stopUpdate(2, "B", { arrivalDelay: 120 })],
  })]);

  assert.equal(result.timestamp, "2026-01-15T07:05:00.000Z");
  assert.equal(result.vehicles.length, 1);
  const vehicle = result.vehicles[0];
  closeTo(vehicle.lon, 13.4 + 0.01 * (5 / 12));
  closeTo(vehicle.lat, 52.5);
  closeTo(vehicle.bearing, 90, 0.005);
  assert.deepEqual(vehicle, {
    vehicleId: "t-bus:20260115:",
    tripId: "t-bus",
    routeId: "r-bus",
    line: "B10",
    lineColor: [18, 130, 220, 255],
    labelColor: [255, 210, 90, 255],
    headsign: "Central Station",
    lon: vehicle.lon,
    lat: vehicle.lat,
    bearing: vehicle.bearing,
    speedKmh: null,
    updatedAt: "2026-01-15T07:05:00.000Z",
    positionSource: "estimated",
    displayText: "≈ B10",
    vehicleType: "bus",
    model: "bus",
    routeType: 3,
    previousStopName: "Start",
    previousDeparture: "2026-01-15T07:00:00.000Z",
    nextStopName: "Middle, East",
    nextStopId: "B",
    nextArrival: "2026-01-15T07:12:00.000Z",
    delaySeconds: 120,
    delayText: "+2 min",
    operator: "Berlin Verkehr",
  });
});

test("uses absolute realtime events and joins updates by stop_id fallback", async () => {
  const index = await setup();
  const result = estimate(index, [tripEntity("t-bus", {
    updates: [
      stopUpdate(undefined, "A", { departureTime: Date.parse("2026-01-15T07:01:00Z") / 1000 }),
      stopUpdate(undefined, "B", { arrivalTime: Date.parse("2026-01-15T07:13:00Z") / 1000 }),
    ],
  })]);
  const vehicle = result.vehicles[0];
  closeTo(vehicle.lon, 13.4 + 0.01 / 3);
  assert.equal(vehicle.previousDeparture, "2026-01-15T07:01:00.000Z");
  assert.equal(vehicle.nextArrival, "2026-01-15T07:13:00.000Z");
  assert.equal(vehicle.delaySeconds, 180);
});

test("keeps a dwelling vehicle at its stop and reports the following stop", async () => {
  const index = await setup();
  const now = Date.parse("2026-01-15T07:10:30.000Z");
  const result = estimate(index, [tripEntity("t-bus", {
    timestamp: now / 1000,
    updates: [stopUpdate(2, "B", { departureDelay: 30 })],
  })], now);
  const vehicle = result.vehicles[0];
  assert.equal(vehicle.lon, 13.41);
  assert.equal(vehicle.lat, 52.5);
  assert.equal(vehicle.previousStopName, "Middle, East");
  assert.equal(vehicle.previousDeparture, "2026-01-15T07:11:30.000Z");
  assert.equal(vehicle.nextStopId, "C");
  assert.equal(vehicle.nextArrival, "2026-01-15T07:20:30.000Z");
  assert.equal(vehicle.delaySeconds, 30);
});

test("resolves service days and times beyond 24h in the agency timezone", async () => {
  const index = await setup();
  const now = Date.parse("2026-01-15T23:05:00.000Z");
  const result = estimate(index, [tripEntity("t-overnight", { timestamp: now / 1000 })], now);
  assert.equal(result.vehicles.length, 1);
  closeTo(result.vehicles[0].lon, 13.405);
  assert.equal(result.vehicles[0].previousDeparture, "2026-01-15T23:00:00.000Z");
  assert.equal(result.vehicles[0].nextArrival, "2026-01-15T23:10:00.000Z");

  for (const outside of [Date.parse("2026-01-15T22:59:59Z"), Date.parse("2026-01-15T23:20:01Z")]) {
    const noExtrapolation = estimate(index, [tripEntity("t-overnight", { timestamp: outside / 1000 })], outside);
    assert.equal(noExtrapolation.vehicles.length, 0);
  }
});

test("skips cancelled, stale and unknown trips, uses stop geometry without shapes, and omits skipped stops", async () => {
  const index = await setup();
  const cancelled = estimate(index, [
    tripEntity("t-bus", { scheduleRelationship: "CANCELED" }),
    tripEntity("t-tram", { timestamp: FEED_TIMESTAMP - 1000 }),
    tripEntity("not-in-static-index"),
  ]);
  assert.deepEqual(cancelled.vehicles, []);
  const stopGeometry = estimate(index, [tripEntity("t-no-shape")]);
  assert.equal(stopGeometry.vehicles.length, 1);
  assert.equal(stopGeometry.vehicles[0].positionSource, "estimated");

  const skipped = estimate(index, [tripEntity("t-bus", {
    updates: [stopUpdate(2, "B", { scheduleRelationship: "SKIPPED" })],
  })]);
  assert.equal(skipped.vehicles.length, 1);
  assert.equal(skipped.vehicles[0].previousStopName, "Start");
  assert.equal(skipped.vehicles[0].nextStopId, "C");
  assert.equal(skipped.vehicles[0].nextArrival, "2026-01-15T07:20:00.000Z");

  index.stops.clear();
  assert.deepEqual(estimate(index, [tripEntity("t-bus")]).vehicles, []);
});

test("skips trips far outside their service window before preparing route geometry", async () => {
  const index = await setup();
  const later = Date.parse("2026-01-15T20:00:00.000Z");
  const result = estimate(index, [tripEntity("t-bus", { timestamp: later / 1000 })], later);
  assert.deepEqual(result.vehicles, []);
  assert.equal(index.preparedShapes.size, 0);
});

test("maps route types to display vehicle types", async () => {
  const index = await setup();
  const result = estimate(index, ["t-bus", "t-tram", "t-train", "t-ferry"].map((tripId) => tripEntity(tripId)));
  assert.deepEqual(Object.fromEntries(result.vehicles.map((vehicle) => [vehicle.tripId, vehicle.vehicleType])), {
    "t-bus": "bus",
    "t-tram": "tram",
    "t-train": "train",
    "t-ferry": "ferry",
  });
  assert.deepEqual(result.vehicles.map((vehicle) => vehicle.routeType), [3, 0, 2, 4]);
  assert.deepEqual(result.vehicles.find(vehicle => vehicle.tripId === "t-tram").lineColor, colorForLine("M1"));
  assert.deepEqual(result.vehicles.find(vehicle => vehicle.tripId === "t-train").lineColor, [227, 6, 19, 255]);
  index.routes.get("r-bus").shortName = "RE83";
  assert.equal(estimate(index, [tripEntity("t-bus")]).vehicles[0].vehicleType, "train");
});

test("selects specialized rail models and exposes IC/ICE at country zoom", async () => {
  const index = await setup();
  const route = index.routes.get("r-train");
  for (const [line, model] of [["ICE 10", "ice"], ["IC 61", "ic"], ["S1", "sbahn"], ["RE1", "train"]]) {
    route.shortName = line;
    const vehicle = estimate(index, [tripEntity("t-train")]).vehicles[0];
    assert.equal(vehicle.model, model);
    assert.equal(vehicle.minZoom, ["ice", "ic"].includes(model) ? 5 : undefined);
  }
  index.routes.get("r-tram").routeType = 1;
  index.routes.get("r-tram").shortName = "U2";
  assert.equal(estimate(index, [tripEntity("t-tram")]).vehicles[0].model, "subway");
});

test("falls back to cumulative haversine shape distances and filters agency and BBOX", async () => {
  const index = await setup();
  for (const point of index.shapes.get("shape-east")) point.distTraveled = null;
  for (const stop of index.trips.get("t-bus").stopTimes) stop.shapeDistTraveled = null;

  const result = estimate(index, [tripEntity("t-bus")]);
  closeTo(result.vehicles[0].lon, 13.405, 0.00001);
  closeTo(result.vehicles[0].bearing, 90, 0.005);
  assert.deepEqual(estimate(index, [tripEntity("t-bus")], BETWEEN_NOW, { agencyIds: ["another"] }).vehicles, []);
  assert.deepEqual(estimate(index, [tripEntity("t-bus")], BETWEEN_NOW, { bbox: [14, 53, 15, 54] }).vehicles, []);
});

test("propagates realtime delays to later stops", async () => {
  const index = await setup();
  const result = estimate(index, [tripEntity("t-bus", {
    updates: [stopUpdate(1, "A", { departureDelay: 120 })],
  })]);
  const vehicle = result.vehicles[0];
  assert.equal(vehicle.previousDeparture, "2026-01-15T07:02:00.000Z");
  assert.equal(vehicle.nextArrival, "2026-01-15T07:12:00.000Z");
  assert.equal(vehicle.delaySeconds, 120);
});

test("applies TripDescriptor.startTime to the static trip template", async () => {
  const index = await setup();
  const now = BETWEEN_NOW + 60 * 60 * 1000;
  const entity = tripEntity("t-bus", { timestamp: now / 1000 });
  entity.tripUpdate.trip.startTime = "09:00:00";
  const result = estimate(index, [entity], now);
  const vehicle = result.vehicles[0];
  assert.equal(vehicle.previousDeparture, "2026-01-15T08:00:00.000Z");
  assert.equal(vehicle.nextArrival, "2026-01-15T08:10:00.000Z");
  assert.ok(vehicle.vehicleId.endsWith(":09:00:00"));
});

test("shifts the active-trip window with a TripDescriptor.startTime override", async () => {
  const index = await setup();
  const now = Date.parse("2026-01-15T19:05:00.000Z");
  const entity = tripEntity("t-bus", { timestamp: now / 1000 });
  entity.tripUpdate.trip.startTime = "20:00:00";
  const result = estimate(index, [entity], now);
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].previousDeparture, "2026-01-15T19:00:00.000Z");
  assert.equal(result.vehicles[0].nextArrival, "2026-01-15T19:10:00.000Z");
});

test("does not attach a sequenced update to another occurrence of a repeated stop", async () => {
  const index = await setup();
  index.trips.get("t-bus").stopTimes[2].stopId = "A";
  const result = estimate(index, [tripEntity("t-bus", {
    updates: [stopUpdate(3, "A", { arrivalDelay: 300 })],
  })]);
  const vehicle = result.vehicles[0];
  assert.equal(vehicle.previousDeparture, "2026-01-15T07:00:00.000Z");
  const lastStop = index.trips.get("t-bus").stopTimes[2];
  assert.equal(lastStop.stopSequence, 3);
});

test("never moves backward and bounds forward corrections per trip", async () => {
  const index = await setup();
  const trackState = new Map();
  const early = estimate(index, [tripEntity("t-bus", {
    updates: [stopUpdate(2, "B", { arrivalDelay: -120 })],
  })], BETWEEN_NOW, { trackState }).vehicles[0];
  const corrected = estimate(index, [tripEntity("t-bus")], BETWEEN_NOW + 30_000, { trackState }).vehicles[0];
  assert.ok(early);
  assert.ok(corrected);
  assert.equal(corrected.lon, early.lon, "a delay correction must not move a vehicle backward");
  assert.equal(corrected.previousLon, early.lon);
  assert.equal(corrected.previousLat, early.lat);
  assert.equal(corrected.previousUpdatedAt, new Date(BETWEEN_NOW).toISOString());

  index.stops.get("B").lon = 14.41;
  index.stops.get("C").lon = 14.42;
  index.shapes.get("shape-east")[1].lon = 14.41;
  index.shapes.get("shape-east")[2].lon = 14.42;
  index.preparedShapes.clear();
  trackState.clear();
  const options = { trackState, bbox: [13, 52, 15, 53] };
  const beforeJump = estimate(index, [tripEntity("t-bus")], BETWEEN_NOW, options).vehicles[0];
  const afterJump = estimate(index, [tripEntity("t-bus", {
    updates: [stopUpdate(2, "B", { arrivalTime: Date.parse("2026-01-15T07:06:00Z") / 1000 })],
  })], BETWEEN_NOW + 30_000, options).vehicles[0];
  const correctionDistance = haversineMeters(beforeJump, afterJump);
  assert.ok(correctionDistance <= 45 * 30 + 0.1,
    `a realtime correction must not teleport a road vehicle (moved ${correctionDistance}m)`);
});

test("does not snap backward to a newly predicted dwell stop", async () => {
  const index = await setup();
  const trackState = new Map();
  const now = Date.parse("2026-01-15T07:15:00.000Z");
  const beforeCorrection = estimate(index, [tripEntity("t-bus", { timestamp: now / 1000 })], now, { trackState }).vehicles[0];
  const afterCorrection = estimate(index, [tripEntity("t-bus", {
    timestamp: (now + 30_000) / 1000,
    updates: [stopUpdate(2, "B", { arrivalDelay: 300 })],
  })], now + 30_000, { trackState }).vehicles[0];
  assert.equal(afterCorrection.previousStopName, "Middle, East");
  assert.equal(afterCorrection.lon, beforeCorrection.lon);
  assert.equal(afterCorrection.lat, beforeCorrection.lat);
});

test("uses receipt time when the feed header and update timestamp are absent", async () => {
  const index = await setup();
  const entity = tripEntity("t-bus");
  delete entity.tripUpdate.timestamp;
  const feed = decodeFeed(feedBuffer({ headerTimestamp: null, entities: [entity] }));
  const result = estimateTripUpdates(feed, index, {
    bbox: OUTPUT_BBOX,
    staleAfterSeconds: 90,
    nowMs: BETWEEN_NOW,
  }, BETWEEN_NOW);
  assert.equal(result.timestamp, "2026-01-15T07:05:00.000Z");
  assert.equal(result.vehicles[0].updatedAt, result.timestamp);
});

test("uses a regional shape instead of stop-to-stop geometry when available", async () => {
  const index = await setup();
  const points = [
    { lat: 52.50, lon: 13.40, sequence: 1, distTraveled: 0 },
    { lat: 52.51, lon: 13.41, sequence: 2, distTraveled: 1000 },
    { lat: 52.50, lon: 13.42, sequence: 3, distTraveled: 2000 },
  ];
  const regionalShapes = new Map([[
    "t-no-shape",
    { regionId: "test-region", shapeId: "region-shape", points },
  ]]);
  const result = estimate(index, [tripEntity("t-no-shape")], BETWEEN_NOW, { regionalShapes });
  assert.equal(result.vehicles.length, 1);
  assert.ok(result.vehicles[0].lat > 52.5001, "the regional shape bends north between the stops");
  assert.ok(result.vehicles[0].lon > 13.4 && result.vehicles[0].lon < 13.42);

  const fallback = estimate(index, [tripEntity("t-no-shape")], BETWEEN_NOW, {
    regionalShapes: new Map([["t-no-shape", { regionId: "test-region", shapeId: "empty", points: [] }]]),
  });
  assert.equal(fallback.vehicles.length, 1);
  closeTo(fallback.vehicles[0].lat, 52.5);
});
