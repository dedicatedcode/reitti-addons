import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { FeedService } from "../src/feed-service.js";
import { feedBuffer, vehicleEntity } from "./helpers.js";
import {
  BETWEEN_NOW,
  OUTPUT_BBOX,
  estimatedStaticZip,
  tripEntity,
} from "./estimated-fixtures.js";

test("estimated mode requires the same GTFS URLs and current BBOX settings", () => {
  assert.throws(() => loadConfig({ FEED_TYPE: "gtfs-rt-estimated" }), /GTFS_RT_URL is required/);
  assert.throws(() => loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://example.invalid/realtime",
  }), /GTFS_STATIC_URL is required/);
  const config = loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://example.invalid/realtime",
    GTFS_STATIC_URL: "https://example.invalid/static.zip",
    BBOX: "13.20,52.35,13.65,52.65",
    PORT: "8090",
    PUBLIC_BASE_URL: "http://localhost:8090",
  });
  assert.equal(config.feedType, "gtfs-rt-estimated");
  assert.deepEqual(config.bbox, [13.20, 52.35, 13.65, 52.65]);
  assert.equal(config.publicBaseUrl, "http://localhost:8090");
});

test("FeedService streams the small static fixture and uses TripUpdates instead of VehiclePositions", async (t) => {
  const archive = estimatedStaticZip();
  const realtime = feedBuffer({
    headerTimestamp: BETWEEN_NOW / 1000,
    entities: [
      tripEntity("t-bus"),
      vehicleEntity("must-be-ignored", { longitude: 13.41, latitude: 52.5 }),
    ],
  });
  const requests = [];
  let now = BETWEEN_NOW;
  const config = loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://fixtures.invalid/realtime",
    GTFS_STATIC_URL: "https://fixtures.invalid/static.zip",
    BBOX: OUTPUT_BBOX.join(","),
  });
  const service = new FeedService(config, {
    now: () => now,
    logger: { error() {} },
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(url.endsWith("static.zip") ? archive : realtime);
    },
  });
  t.after(() => service.stop());

  assert.equal(await service.refreshAll(), undefined);
  assert.deepEqual(requests, [config.gtfsRtUrl, config.gtfsStaticUrl, config.gtfsRtUrl]);
  assert.equal(service.getSnapshot().vehicles.length, 1);
  assert.equal(service.getSnapshot().vehicles[0].vehicleId, "t-bus:20260115:");
  assert.equal(service.getSnapshot().vehicles[0].positionSource, "estimated");
  const initialLongitude = service.getSnapshot().vehicles[0].lon;
  now += 10_000;
  assert.equal(service.getSnapshot().vehicles[0].lon, initialLongitude,
    "API snapshots are served from the background cache without re-estimating");
  assert.equal(await service.refreshEstimate(), true);
  assert.ok(service.getSnapshot().vehicles[0].lon > initialLongitude,
    "the background estimate updates cached positions");
  assert.equal(requests.length, 3, "estimating a fresh position does not refetch upstream data");
  assert.equal(service.getHealth().status, "ok");
  assert.ok(service.staticFeed.trips.has("t-bus"));
  assert.equal(service.staticFeed.trips.has("t-outside"), false);
});

test("FeedService exposes static indexing errors and retains the previous index", async (t) => {
  const config = loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://fixtures.invalid/realtime",
    GTFS_STATIC_URL: "https://fixtures.invalid/static.zip",
    BBOX: OUTPUT_BBOX.join(","),
  });
  let archive = estimatedStaticZip();
  const service = new FeedService(config, {
    now: () => BETWEEN_NOW,
    logger: { error() {} },
    fetchImpl: async (url) => new Response(url.endsWith("static.zip") ? archive : feedBuffer({
      headerTimestamp: BETWEEN_NOW / 1000,
      entities: [tripEntity("t-bus")],
    })),
  });
  t.after(() => service.stop());
  assert.equal(await service.refreshStatic(), true);
  const previous = service.staticFeed;
  archive = Buffer.from("broken zip");
  assert.equal(await service.refreshStatic(), false);
  assert.equal(service.staticFeed, previous);
  assert.match(service.getHealth().static.lastError, /open static GTFS ZIP/);
  assert.equal(service.getHealth().status, "degraded");
});

test("reuses an unchanged static index and only rebuilds for new trips after the cooldown", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "reitti-static-index-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const archive = estimatedStaticZip();
  let realtime = feedBuffer({
    headerTimestamp: Math.floor(BETWEEN_NOW / 1000),
    entities: [tripEntity("t-bus")],
  });
  let now = BETWEEN_NOW;
  let staticRequests = 0;
  const config = loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://fixtures.invalid/realtime",
    GTFS_STATIC_URL: "https://fixtures.invalid/static.zip",
    BBOX: OUTPUT_BBOX.join(","),
    STATIC_CACHE_DIR: cacheDir,
    STATIC_INDEX_REBUILD_INTERVAL_MS: "60000",
  });
  const service = new FeedService(config, {
    now: () => now,
    logger: { info() {}, error() {} },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("static.zip")) {
        staticRequests += 1;
        if (options.headers?.["if-none-match"] === '"static-etag"') {
          return new Response(null, { status: 304 });
        }
        return new Response(archive, { headers: { etag: '"static-etag"' } });
      }
      return new Response(realtime);
    },
  });
  t.after(() => service.stop());

  assert.equal(await service.refreshStatic(), true);
  const firstIndex = service.staticFeed;
  assert.equal(await service.refreshStatic(), true);
  assert.equal(staticRequests, 2);
  assert.equal(service.staticFeed, firstIndex, "an unchanged archive keeps the parsed index");

  realtime = feedBuffer({
    headerTimestamp: Math.floor(BETWEEN_NOW / 1000),
    entities: [tripEntity("t-bus"), tripEntity("t-tram")],
  });
  now += 60_001;
  assert.equal(await service.refreshStatic(), true);
  assert.notEqual(service.staticFeed, firstIndex);
  assert.equal(service.staticFeed.trips.has("t-bus"), true);
  assert.equal(service.staticFeed.trips.has("t-tram"), true);
});

test("applies and removes regional shapes through the estimated service", async (t) => {
  const archive = estimatedStaticZip();
  const realtime = feedBuffer({
    headerTimestamp: Math.floor(BETWEEN_NOW / 1000),
    entities: [tripEntity("t-no-shape")],
  });
  const config = loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://fixtures.invalid/realtime",
    GTFS_STATIC_URL: "https://fixtures.invalid/static.zip",
    BBOX: OUTPUT_BBOX.join(","),
  });
  const service = new FeedService(config, {
    now: () => BETWEEN_NOW,
    logger: { info() {}, error() {} },
    fetchImpl: async (url) => new Response(url.endsWith("static.zip") ? archive : realtime),
  });
  t.after(() => service.stop());
  assert.equal(await service.refreshAll(), undefined);
  const before = service.getSnapshot().vehicles.find((vehicle) => vehicle.tripId === "t-no-shape");
  assert.ok(before);

  const points = [
    { lat: 52.50, lon: 13.40, sequence: 1, distTraveled: 0 },
    { lat: 52.51, lon: 13.41, sequence: 2, distTraveled: 1000 },
    { lat: 52.50, lon: 13.42, sequence: 3, distTraveled: 2000 },
  ];
  service.applyRegionalShapes("test-region", new Map([[
    "t-no-shape",
    { shapeId: "region-shape", points },
  ]]));
  await service.refreshEstimate();
  const shaped = service.getSnapshot().vehicles.find((vehicle) => vehicle.tripId === "t-no-shape");
  assert.ok(shaped.lat > 52.5001);
  assert.equal(service.regionalShapes.size, 1);

  service.removeRegionalShapes("test-region");
  assert.equal(service.regionalShapes.size, 0);
  await service.refreshEstimate();
  const fallback = service.getSnapshot().vehicles.find((vehicle) => vehicle.tripId === "t-no-shape");
  assert.ok(Math.abs(fallback.lat - 52.5) < 0.000001);
});

test("uses conditional realtime requests and treats 304 as a successful refresh", async (t) => {
  const archive = estimatedStaticZip();
  const realtime = feedBuffer({
    headerTimestamp: Math.floor(BETWEEN_NOW / 1000),
    entities: [tripEntity("t-bus")],
  });
  const calls = [];
  const config = loadConfig({
    FEED_TYPE: "gtfs-rt-estimated",
    GTFS_RT_URL: "https://fixtures.invalid/realtime",
    GTFS_STATIC_URL: "https://fixtures.invalid/static.zip",
    BBOX: OUTPUT_BBOX.join(","),
  });
  const service = new FeedService(config, {
    now: () => BETWEEN_NOW,
    logger: { info() {}, error() {} },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, headers: options.headers || {} });
      if (url.endsWith("static.zip")) return new Response(archive);
      if (options.headers?.["if-none-match"] === '"realtime-etag"') {
        return new Response(null, { status: 304 });
      }
      return new Response(realtime, {
        headers: {
          etag: '"realtime-etag"',
          "last-modified": "Mon, 15 Jan 2026 07:00:00 GMT",
        },
      });
    },
  });
  t.after(() => service.stop());
  assert.equal(await service.refreshAll(), undefined);
  assert.equal(await service.refreshRealtime(), true);
  const realtimeCalls = calls.filter((call) => call.url.endsWith("realtime"));
  assert.equal(realtimeCalls.length, 3);
  assert.equal(realtimeCalls[0].headers["if-none-match"], undefined);
  assert.equal(realtimeCalls[1].headers["if-none-match"], undefined);
  assert.equal(realtimeCalls[2].headers["if-none-match"], '"realtime-etag"');
  assert.equal(service.getHealth().status, "ok");
  assert.equal(service.getHealth().realtime.lastError, null);
  assert.equal(await service.refreshRealtime(), true);
  assert.equal(calls.filter((call) => call.url.endsWith("realtime")).length, 4);
  assert.equal(service.getHealth().realtime.lastError, null);
});
