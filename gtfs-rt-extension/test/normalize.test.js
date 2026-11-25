import test from "node:test";
import assert from "node:assert/strict";
import { colorForLine } from "../src/colors.js";
import { normalizeFeed } from "../src/normalize.js";
import { emptyStaticFeed, parseStaticFeed } from "../src/static-feed.js";
import {
  NOW_MS,
  decodeFeed,
  feedBuffer,
  staticZip,
  vehicleEntity,
} from "./helpers.js";

const options = {
  bbox: [10.55, 53.78, 10.92, 53.99],
  agencyIds: [],
  staleAfterSeconds: 90,
  nowMs: NOW_MS,
};

test("normalizes vehicle positions and joins static routes and trips", async () => {
  const staticFeed = await parseStaticFeed(staticZip());
  const feed = decodeFeed(feedBuffer({
    entities: [vehicleEntity("entity-1", {
      timestamp: 950,
      bearing: 135,
      speed: 10,
    })],
  }));

  const normalized = normalizeFeed(feed, staticFeed, options, NOW_MS);
  assert.equal(normalized.timestamp, "1970-01-01T00:16:20.000Z");
  assert.equal(normalized.vehicles.length, 1);
  const { lon, lat, ...vehicle } = normalized.vehicles[0];
  assert.ok(Math.abs(lon - 10.7) < 0.000001);
  assert.ok(Math.abs(lat - 53.86) < 0.000001);
  assert.deepEqual(vehicle, {
    vehicleId: "entity-1",
    tripId: "t1",
    routeId: "r1",
    line: "1",
    lineColor: colorForLine("1"),
    labelColor: colorForLine("1"),
    headsign: "Hauptbahnhof, Zentrum",
    bearing: 135,
    speedKmh: 36,
    updatedAt: "1970-01-01T00:15:50.000Z",
    positionSource: "live",
    displayText: "1",
    vehicleType: "bus",
    model: "bus",
  });
});

test("uses an official route color when supplied and a deterministic line fallback otherwise", async () => {
  const staticFeed = await parseStaticFeed(staticZip());
  const feed = decodeFeed(feedBuffer({ entities: [vehicleEntity("entity-1")] }));
  staticFeed.routes.get("r1").lineColor = "#336699";
  const official = normalizeFeed(feed, staticFeed, options, NOW_MS);
  assert.deepEqual(official.vehicles[0].lineColor, [51, 102, 153, 255]);

  delete staticFeed.routes.get("r1").lineColor;
  const fallback = normalizeFeed(feed, staticFeed, options, NOW_MS);
  const repeated = normalizeFeed(feed, staticFeed, options, NOW_MS);
  assert.deepEqual(fallback.vehicles[0].lineColor, colorForLine("1"));
  assert.deepEqual(repeated.vehicles[0].lineColor, fallback.vehicles[0].lineColor);
});

test("uses entity, feed, then received timestamps for stale pruning and updatedAt", async () => {
  const staticFeed = await parseStaticFeed(staticZip());
  const feed = decodeFeed(feedBuffer({
    headerTimestamp: 980,
    entities: [
      vehicleEntity("fresh", { timestamp: 950 }),
      vehicleEntity("feed-fallback"),
      vehicleEntity("stale", { timestamp: 900 }),
      vehicleEntity("boundary", { timestamp: 910 }),
    ],
  }));
  const normalized = normalizeFeed(feed, staticFeed, options, NOW_MS);

  assert.deepEqual(normalized.vehicles.map((vehicle) => vehicle.vehicleId), [
    "fresh",
    "feed-fallback",
    "boundary",
  ]);
  assert.equal(normalized.vehicles[1].updatedAt, "1970-01-01T00:16:20.000Z");
  assert.equal(normalized.vehicles[1].bearing, 0);
  assert.equal(normalized.vehicles[1].speedKmh, null);

  const withoutTimestamps = decodeFeed(feedBuffer({
    headerTimestamp: null,
    entities: [vehicleEntity("received-fallback")],
  }));
  const received = normalizeFeed(withoutTimestamps, staticFeed, options, NOW_MS);
  assert.equal(received.timestamp, "1970-01-01T00:16:40.000Z");
  assert.equal(received.vehicles[0].updatedAt, "1970-01-01T00:16:40.000Z");
});

test("filters by bounding box and optional route agency", async () => {
  const staticFeed = await parseStaticFeed(staticZip());
  const feed = decodeFeed(feedBuffer({
    entities: [
      vehicleEntity("allowed"),
      vehicleEntity("other-agency", { tripId: "t2" }),
      vehicleEntity("outside", { longitude: 11.1 }),
      vehicleEntity("unknown-agency", { tripId: undefined, routeId: "missing" }),
    ],
  }));

  const allAgencies = normalizeFeed(feed, staticFeed, options, NOW_MS);
  assert.deepEqual(allAgencies.vehicles.map((vehicle) => vehicle.vehicleId), [
    "allowed",
    "other-agency",
    "unknown-agency",
  ]);

  const filtered = normalizeFeed(feed, staticFeed, { ...options, agencyIds: ["svl"] }, NOW_MS);
  assert.deepEqual(filtered.vehicles.map((vehicle) => vehicle.vehicleId), ["allowed"]);
});

test("joins route through trips.txt when TripDescriptor.route_id is absent", async () => {
  const staticFeed = await parseStaticFeed(staticZip());
  const feed = decodeFeed(feedBuffer({
    entities: [vehicleEntity("trip-route", { routeId: undefined })],
  }));
  const result = normalizeFeed(feed, staticFeed, options, NOW_MS);
  assert.equal(result.vehicles[0].routeId, "r1");
  assert.equal(result.vehicles[0].line, "1");
});

test("skips malformed or incomplete positions without retaining history", () => {
  const feed = decodeFeed(feedBuffer({
    entities: [
      vehicleEntity("bad-latitude", { latitude: 100 }),
      { id: "not-a-vehicle-position" },
    ],
  }));
  const result = normalizeFeed(feed, emptyStaticFeed(), options, NOW_MS);
  assert.deepEqual(result.vehicles, []);
});
