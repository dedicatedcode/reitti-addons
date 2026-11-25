import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { UnifiedFeedService } from "../src/unified-feed-service.js";

function vehicle(vehicleId, lon, lat) {
  return { vehicleId, lon, lat };
}

function createHarness({ now = () => Date.now(), snapshots = null } = {}) {
  const config = loadConfig({
    FEED_TYPE: "germany",
    GTFS_RT_URL: "https://example.invalid/realtime",
    GTFS_STATIC_URL: "https://example.invalid/static.zip",
    BBOX: "13.20,52.35,13.65,52.65",
    BERLIN_BBOX: "13.20,52.35,13.65,52.65",
    MUNSTER_BBOX: "7.45,51.80,7.80,52.15",
    LIVE_CITY_IDLE_TIMEOUT_MS: "10000",
  });
  const fixtures = snapshots || {
    "gtfs-rt-estimated": {
      timestamp: "2026-01-01T12:00:00.000Z",
      vehicles: [vehicle("estimated-berlin", 13.4, 52.5), vehicle("estimated-muenster", 7.6, 51.95), vehicle("estimated-other", 10.7, 53.86)],
    },
    "transport-rest": { timestamp: "2026-01-01T12:00:02.000Z", vehicles: [vehicle("live-berlin", 13.4, 52.5)] },
    busradar: { timestamp: "2026-01-01T12:00:01.000Z", vehicles: [vehicle("live-muenster", 7.6, 51.95)] },
  };
  const services = [];
  const factory = (childConfig) => {
    const service = {
      config: childConfig,
      started: false,
      start() { this.started = true; return Promise.resolve(); },
      refreshAll() { return Promise.resolve(); },
      stop() { this.started = false; },
      getSnapshot() { return fixtures[childConfig.feedType]; },
      getHealth() { return { status: "ok", timestamp: fixtures[childConfig.feedType].timestamp }; },
    };
    services.push(service);
    return service;
  };
  const service = new UnifiedFeedService(config, { now }, factory);
  return { config, service, services };
}

test("one German extension merges live coverage on demand and estimates elsewhere", async () => {
  const { service, services } = createHarness();

  await service.start();
  assert.equal(services.length, 1, "only the national estimated feed starts at startup");
  assert.equal(services[0].started, true);
  assert.equal(service.getHealth().sources.berlin.status, "idle");
  assert.equal(service.getHealth().sources.muenster.status, "idle");

  service.observeViewport(null, 12);
  assert.equal(services.length, 3, "a national request activates both live city feeds");
  assert.deepEqual(service.getSnapshot().vehicles.map(vehicle => vehicle.vehicleId), [
    "estimated-other", "live-berlin", "live-muenster",
  ]);
  assert.equal(service.getSnapshot().timestamp, "2026-01-01T12:00:02.000Z");
  assert.equal(service.getHealth().status, "ok");
  assert.equal(service.getHealth().vehicles, 3);
  assert.equal(service.getHealth().estimated.total, 3);
  assert.equal(service.getHealth().estimated.filteredInsideLiveCityBoxes, 2);
  assert.equal(service.getHealth().estimated.outsideLiveCityBoxes, 1);
  assert.equal(service.getHealth().sources.estimated.status, "ok");
  assert.equal(services[0].config.refreshIntervalMs, 15_000);

  await service.refreshAll();
  service.stop();
  assert.ok(services.every(child => !child.started));
});

test("live city feeds activate only for intersecting viewports at the live zoom floor", async () => {
  const { service, services } = createHarness();
  await service.start();

  service.observeViewport([10.65, 53.85, 10.74, 53.87], 15);
  assert.equal(services.length, 1, "Lübeck does not activate a live city feed");

  service.observeViewport([13.39, 52.50, 13.42, 52.53], 9);
  assert.equal(services.length, 1, "Berlin below LIVE_CITY_MIN_ZOOM stays on estimates");

  service.observeViewport([13.39, 52.50, 13.42, 52.53], 10);
  assert.equal(services.length, 2, "Berlin activates at the live zoom floor");
  assert.equal(service.getHealth().sources.berlin.status, "ok");
  assert.equal(service.getHealth().sources.muenster.status, "idle");

  service.stop();
});

test("idle live feeds stop and reactivate with a fresh service", async () => {
  let now = 1_000_000;
  const { service, services } = createHarness({ now: () => now });
  await service.start();

  service.observeViewport([13.39, 52.50, 13.42, 52.53], 12);
  assert.equal(services.length, 2);
  assert.equal(services[1].started, true);

  now += 10_001;
  service.deactivateIdleLiveServices();
  assert.equal(services.length, 2, "the old service is removed, not reused");
  assert.equal(services[1].started, false);
  assert.equal(service.getHealth().sources.berlin.status, "idle");

  service.observeViewport([13.39, 52.50, 13.42, 52.53], 12);
  assert.equal(services.length, 3, "reactivation creates a fresh service");
  assert.equal(services[2].started, true);
  assert.equal(service.getHealth().sources.berlin.status, "ok");

  service.stop();
});
