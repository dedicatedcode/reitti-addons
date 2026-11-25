import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { FeedService } from "../src/feed-service.js";
import { close, listen } from "./helpers.js";

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");
const REAL_URL = "https://v6.vbb.transport.rest/radar";

function payload(lon = 13.40) {
  return {
    realtimeDataUpdatedAt: NOW_MS / 1000,
    movements: [{
      tripId: "trip-1",
      location: { type: "location", longitude: lon, latitude: 52.50 },
      line: {
        type: "line",
        id: "u2",
        name: "U2",
        mode: "subway",
        operator: { type: "operator", id: "bvg", name: "Berliner Verkehrsbetriebe" },
      },
      direction: "U Ruhleben",
      nextStopovers: [{
        stop: { type: "stop", id: "900003201", name: "U Alexanderplatz" },
        arrival: "2026-01-01T12:01:00+01:00",
        arrivalDelay: 30,
      }],
      frames: [{ t: 30000, location: { longitude: 13.60, latitude: 52.60 } }],
    }],
  };
}

test("loads transport.rest defaults without GTFS URLs and polls every thirty seconds", () => {
  const config = loadConfig({ FEED_TYPE: "transport-rest" });
  assert.equal(config.feedType, "transport-rest");
  assert.equal(config.transportRestUrl, REAL_URL);
  assert.equal(config.transportRestResults, 10_000);
  assert.equal(config.gtfsRtUrl, null);
  assert.equal(config.gtfsStaticUrl, null);
  assert.equal(config.busRadarUrl, null);
  assert.equal(config.refreshIntervalMs, 15_000);
  assert.throws(() => loadConfig({
    FEED_TYPE: "transport-rest",
    TRANSPORT_REST_URL: "file:///tmp/radar",
  }), /TRANSPORT_REST_URL/);
});

test("queries a loopback radar service and becomes ready without static GTFS", async (t) => {
  let now = NOW_MS;
  let responsePayload = payload();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, accept: request.headers.accept });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responsePayload));
  });
  const baseUrl = await listen(server);
  const config = loadConfig({
    FEED_TYPE: "transport-rest",
    TRANSPORT_REST_URL: `${baseUrl}/radar?language=de`,
    BBOX: "13.20,52.35,13.65,52.65",
    REFRESH_INTERVAL_MS: "60000",
  });
  const service = new FeedService(config, { now: () => now, logger: { error() {} } });
  t.after(async () => {
    service.stop();
    await close(server);
  });

  await service.start();
  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0].url, baseUrl);
  assert.equal(requestUrl.pathname, "/radar");
  assert.equal(requestUrl.searchParams.get("language"), "de");
  assert.deepEqual(Object.fromEntries(["north", "west", "south", "east", "results", "duration", "frames", "polylines"]
    .map(name => [name, requestUrl.searchParams.get(name)])), {
    north: "52.65",
    west: "13.2",
    south: "52.35",
    east: "13.65",
    results: "10000",
    duration: "30",
    frames: "0",
    polylines: "false",
  });
  assert.equal(requests[0].accept, "application/json");
  assert.equal(service.staticTimer, null);
  assert.ok(service.realtimeTimer);
  assert.equal(service.getSnapshot().vehicles[0].vehicleId, "trip-1");
  assert.equal(service.getSnapshot().vehicles[0].vehicleType, "tram");
  assert.equal(service.getSnapshot().vehicles[0].lon, 13.40);

  const health = service.getHealth();
  assert.equal(health.status, "ok");
  assert.ok(health.realtime.lastSuccessAt);
  assert.equal(health.static.lastAttemptAt, null);
  assert.equal(health.static.lastSuccessAt, null);

  now += 1000;
  responsePayload = payload(13.401);
  assert.equal(await service.refreshRealtime(), true);
  assert.ok(service.getSnapshot().vehicles[0].bearing > 89);
  assert.ok(service.getSnapshot().vehicles[0].bearing < 91);
  assert.equal(service.transportRestTracks.size, 1);

  assert.equal(await service.refreshStatic(), true);
  assert.equal(requests.length, 2, "static refresh must not fetch for transport.rest");
});
