import test from "node:test";
import assert from "node:assert/strict";
import { colorForLine } from "../src/colors.js";
import { normalizeTransportRestFeed } from "../src/normalize-transport-rest.js";

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");
const NOW_SECONDS = NOW_MS / 1000;
const options = {
  bbox: [13.20, 52.35, 13.65, 52.65],
  staleAfterSeconds: 90,
  nowMs: NOW_MS,
};

function movement(tripId = "trip-1", {
  lon = 13.40,
  lat = 52.50,
  mode = "tram",
  line = {},
  nextStopovers,
  ...properties
} = {}) {
  return {
    tripId,
    location: { type: "location", longitude: lon, latitude: lat },
    line: {
      type: "line",
      id: "m4",
      name: "M4",
      mode,
      operator: { type: "operator", id: "bvg", name: "Berliner Verkehrsbetriebe" },
      color: { bg: "#cc0066" },
      ...line,
    },
    direction: "S Hackescher Markt",
    nextStopovers: nextStopovers === undefined ? [{
      stop: { type: "stop", id: "900100001", name: "S Hackescher Markt" },
      arrival: "2026-01-01T12:02:00+01:00",
      arrivalDelay: 60,
      departure: "2026-01-01T12:02:30+01:00",
      departureDelay: 90,
    }] : nextStopovers,
    frames: [
      { t: 0, location: { longitude: 13.61, latitude: 52.61 } },
      { t: 30000, location: { longitude: 13.62, latitude: 52.62 } },
    ],
    ...properties,
  };
}

function feed(movements, realtimeDataUpdatedAt = NOW_SECONDS - 5) {
  return { movements, realtimeDataUpdatedAt };
}

test("normalizes the current movement location and stop metadata without using future frames", () => {
  const result = normalizeTransportRestFeed(feed([movement()]), options, NOW_MS);

  assert.deepEqual(result, {
    timestamp: "2026-01-01T12:00:00.000Z",
    vehicles: [{
      vehicleId: "trip-1",
      tripId: "trip-1",
      routeId: "m4",
      line: "M4",
      lineColor: [204, 0, 102, 255],
      labelColor: [204, 0, 102, 255],
      headsign: "S Hackescher Markt",
      lon: 13.40,
      lat: 52.50,
      bearing: 0,
      speedKmh: null,
      updatedAt: "2026-01-01T11:59:55.000Z",
      positionSource: "live",
      displayText: "M4",
      vehicleType: "tram",
      model: "tram",
      nextStopName: "S Hackescher Markt",
      nextStopId: "900100001",
      nextArrival: "2026-01-01T12:02:00+01:00",
      delaySeconds: 60,
      delayText: "+1 min",
      operator: "Berliner Verkehrsbetriebe",
    }],
  });
});

test("uses a deterministic line fallback when transport.rest has no official color", () => {
  const result = normalizeTransportRestFeed(feed([
    movement("fallback", { line: { color: null } }),
  ]), options, NOW_MS);
  assert.deepEqual(result.vehicles[0].lineColor, colorForLine("M4"));
});

test("maps transport modes and uses departure or generic when metadata as fallbacks", () => {
  const modes = ["bus", "train", "tram", "ferry", "subway", "taxi"];
  const movements = modes.map((mode, index) => movement(`trip-${index}`, {
    mode,
    nextStopovers: [{
      stop: { id: `stop-${index}`, name: `Stop ${index}` },
      arrival: null,
      arrivalDelay: null,
      departure: "2026-01-01T12:03:00+01:00",
      departureDelay: index,
    }],
  }));
  movements.push(movement("generic-when", {
    mode: "taxi",
    nextStopovers: [{ stop: { id: "stop-when", name: "When stop" }, when: "2026-01-01T12:04:00+01:00" }],
  }));

  const result = normalizeTransportRestFeed(feed(movements), options, NOW_MS);
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.vehicleType), [
    "bus", "train", "tram", "ferry", "tram", "other", "other",
  ]);
  assert.equal(result.vehicles[4].model, "subway");
  assert.equal(result.vehicles[0].delaySeconds, 0, "zero delays must be preserved");
  assert.equal(result.vehicles[0].nextArrival, "2026-01-01T12:03:00+01:00");
  assert.equal(result.vehicles.at(-1).nextArrival, "2026-01-01T12:04:00+01:00");
  assert.equal(result.vehicles.at(-1).delaySeconds, null);
});

test("filters stale, invalid and outside movements, uses receipt time and deduplicates by trip", () => {
  const fresh = normalizeTransportRestFeed(feed([
    movement("duplicate", { line: { name: "old" }, lon: 13.41 }),
    movement("duplicate", { line: { name: "new" } }),
    movement("outside", { lon: 13.66 }),
    movement("invalid", { lat: 91 }),
    movement("missing-location", { location: null }),
    movement(null),
    { tripId: "missing-trip-location" },
  ], null), options, NOW_MS);

  assert.equal(fresh.vehicles.length, 1);
  assert.equal(fresh.vehicles[0].vehicleId, "duplicate");
  assert.equal(fresh.vehicles[0].line, "new");
  assert.equal(fresh.vehicles[0].updatedAt, "2026-01-01T12:00:00.000Z");

  const stale = normalizeTransportRestFeed(feed([movement()], NOW_SECONDS - 91), options, NOW_MS);
  assert.deepEqual(stale.vehicles, []);
});

test("derives bearing from previous current positions and retains it below two meters", () => {
  const tracks = new Map([
    ["trip-1", { lon: 13.40, lat: 52.50, bearing: 270 }],
    ["retired", { lon: 13.41, lat: 52.51, bearing: 45 }],
  ]);
  const almostStationary = normalizeTransportRestFeed(feed([
    movement("trip-1", { lat: 52.50001 }),
  ]), options, NOW_MS, tracks);

  assert.equal(almostStationary.vehicles[0].bearing, 270);
  assert.deepEqual([...tracks.keys()], ["trip-1"]);

  const moved = normalizeTransportRestFeed(feed([
    movement("trip-1", { lon: 13.401, lat: 52.50001 }),
  ]), options, NOW_MS, tracks);
  assert.ok(moved.vehicles[0].bearing > 89 && moved.vehicles[0].bearing < 91);
  assert.deepEqual(tracks.get("trip-1"), {
    lon: 13.401,
    lat: 52.50001,
    bearing: moved.vehicles[0].bearing,
    timeMs: NOW_MS - 5_000,
  });
  assert.equal(moved.vehicles[0].previousLon, 13.40);
  assert.equal(moved.vehicles[0].previousLat, 52.50001);
  assert.equal(moved.vehicles[0].previousBearing, 270);
});

test("rejects responses without a movements array", () => {
  assert.throws(() => normalizeTransportRestFeed({}, options, NOW_MS), /movements array/);
  assert.throws(() => normalizeTransportRestFeed({ movements: null }, options, NOW_MS), /movements array/);
});
