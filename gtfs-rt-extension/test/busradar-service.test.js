import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { FeedService } from "../src/feed-service.js";

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");
const REAL_URL = "https://rest.busradar.conterra.de/prod/fahrzeuge";

function payload(lon = 7.62) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, 51.95] },
      properties: {
        fahrzeugid: "bus-1",
        fahrtbezeichner: "trip-1",
        linienid: "route-1",
        linientext: "1",
        richtungstext: "Hauptbahnhof",
        visfahrplanlagezst: NOW_MS / 1000,
      },
    }],
  };
}

test("loads Busradar defaults without requiring GTFS URLs", () => {
  const config = loadConfig({ FEED_TYPE: "busradar" });
  assert.equal(config.feedType, "busradar");
  assert.equal(config.busRadarUrl, REAL_URL);
  assert.equal(config.gtfsRtUrl, null);
  assert.equal(config.gtfsStaticUrl, null);
  assert.throws(() => loadConfig({ FEED_TYPE: "other" }), /FEED_TYPE/);
  assert.throws(() => loadConfig({ FEED_TYPE: "busradar", BUS_RADAR_URL: "file:///tmp/feed" }), /BUS_RADAR_URL/);
});

test("runs Busradar without static refreshes and becomes ready after realtime success", async (t) => {
  let now = NOW_MS;
  let responsePayload = payload();
  const requests = [];
  const config = loadConfig({
    FEED_TYPE: "busradar",
    BUS_RADAR_URL: "https://fixtures.invalid/fahrzeuge",
    BBOX: "7.45,51.80,7.80,52.15",
    REFRESH_INTERVAL_MS: "60000",
  });
  const service = new FeedService(config, {
    now: () => now,
    logger: { error() {} },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/geo+json" },
      });
    },
  });
  t.after(() => service.stop());

  await service.start();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://fixtures.invalid/fahrzeuge");
  assert.match(requests[0].options.headers.accept, /geo\+json/);
  assert.equal(service.staticTimer, null);
  assert.ok(service.realtimeTimer);
  assert.equal(service.getSnapshot().vehicles[0].vehicleId, "bus-1");
  assert.deepEqual(Object.keys(service.getSnapshot()), ["timestamp", "vehicles"]);

  const health = service.getHealth();
  assert.equal(health.status, "ok");
  assert.ok(health.realtime.lastSuccessAt);
  assert.equal(health.static.lastAttemptAt, null);
  assert.equal(health.static.lastSuccessAt, null);

  now += 1000;
  responsePayload = payload(7.621);
  assert.equal(await service.refreshRealtime(), true);
  assert.ok(service.getSnapshot().vehicles[0].bearing > 89);
  assert.ok(service.getSnapshot().vehicles[0].bearing < 91);
  assert.equal(service.busRadarTracks.size, 1);

  assert.equal(await service.refreshStatic(), true);
  assert.equal(requests.length, 2, "static refresh must not fetch for Busradar");
});
