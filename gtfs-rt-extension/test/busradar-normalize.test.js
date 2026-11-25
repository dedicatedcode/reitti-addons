import test from "node:test";
import assert from "node:assert/strict";
import { colorForLine } from "../src/colors.js";
import { normalizeBusradarFeed } from "../src/normalize-busradar.js";

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");
const NOW_SECONDS = NOW_MS / 1000;
const options = {
  bbox: [7.45, 51.80, 7.80, 52.15],
  staleAfterSeconds: 90,
  nowMs: NOW_MS,
};

function feature(vehicleId, {
  lon = 7.62,
  lat = 51.95,
  timestamp = NOW_SECONDS - 10,
  ...properties
} = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      fahrzeugid: vehicleId,
      fahrtbezeichner: "trip-1",
      linienid: "route-1",
      linientext: "1",
      richtungstext: "Hauptbahnhof",
      visfahrplanlagezst: timestamp,
      ...properties,
    },
  };
}

function collection(features) {
  return { type: "FeatureCollection", features };
}

test("normalizes Münster Busradar properties and prefers the newest duplicate", () => {
  const result = normalizeBusradarFeed(collection([
    feature("bus-1"),
    feature("bus-1", {
      timestamp: NOW_SECONDS - 20,
      linientext: "outdated",
      lon: 7.63,
    }),
  ]), options, NOW_MS);

  assert.deepEqual(result, {
    timestamp: "2026-01-01T12:00:00.000Z",
    vehicles: [{
      vehicleId: "bus-1",
      tripId: "trip-1",
      routeId: "route-1",
      line: "1",
      lineColor: colorForLine("1"),
      labelColor: colorForLine("1"),
      headsign: "Hauptbahnhof",
      lon: 7.62,
      lat: 51.95,
      bearing: 0,
      speedKmh: null,
      updatedAt: "2026-01-01T11:59:50.000Z",
      positionSource: "live",
      displayText: "1",
      vehicleType: "bus",
      model: "bus",
    }],
  });
});

test("assigns stable fallback colors by Busradar line", () => {
  const first = normalizeBusradarFeed(collection([feature("bus-1")]), options, NOW_MS);
  const second = normalizeBusradarFeed(collection([feature("bus-2")]), options, NOW_MS);
  assert.deepEqual(first.vehicles[0].lineColor, second.vehicles[0].lineColor);
  assert.deepEqual(first.vehicles[0].lineColor, colorForLine("1"));
});

test("uses receipt time for missing timestamps and filters stale, outside and invalid features", () => {
  const result = normalizeBusradarFeed(collection([
    feature("received", { timestamp: null }),
    feature("stale", { timestamp: NOW_SECONDS - 91 }),
    feature("outside", { lon: 7.81 }),
    feature("invalid-latitude", { lat: 100 }),
    feature("missing-id", { fahrzeugid: undefined }),
    feature(42, { linientext: "", linienid: 42 }),
    { type: "Feature", geometry: null, properties: {} },
  ]), options, NOW_MS);

  assert.deepEqual(result.vehicles.map((vehicle) => vehicle.vehicleId), ["received", "42"]);
  assert.equal(result.vehicles[0].updatedAt, "2026-01-01T12:00:00.000Z");
  assert.equal(result.vehicles[1].routeId, "42");
  assert.equal(result.vehicles[1].line, "42");
});

test("retains bearing below two meters, calculates it after movement and prunes old tracks", () => {
  const tracks = new Map([
    ["bus-1", { lon: 7.62, lat: 51.95, bearing: 270 }],
    ["retired", { lon: 7.63, lat: 51.96, bearing: 45 }],
  ]);
  const almostStationary = normalizeBusradarFeed(collection([
    feature("bus-1", { lat: 51.95001 }),
  ]), options, NOW_MS, tracks);

  assert.equal(almostStationary.vehicles[0].bearing, 270);
  assert.deepEqual([...tracks.keys()], ["bus-1"]);

  const moved = normalizeBusradarFeed(collection([
    feature("bus-1", { lon: 7.621, lat: 51.95001 }),
  ]), options, NOW_MS, tracks);
  assert.ok(moved.vehicles[0].bearing > 89 && moved.vehicles[0].bearing < 91);
  assert.deepEqual(tracks.get("bus-1"), {
    lon: 7.621,
    lat: 51.95001,
    bearing: moved.vehicles[0].bearing,
    timeMs: NOW_MS - 10_000,
  });
  assert.equal(moved.vehicles[0].previousLon, 7.62);
  assert.equal(moved.vehicles[0].previousLat, 51.95001);
  assert.equal(moved.vehicles[0].previousBearing, 270);
});

test("rejects responses that are not GeoJSON FeatureCollections", () => {
  assert.throws(() => normalizeBusradarFeed({ features: [] }, options, NOW_MS), /FeatureCollection/);
  assert.throws(() => normalizeBusradarFeed({ type: "FeatureCollection" }, options, NOW_MS), /FeatureCollection/);
});
