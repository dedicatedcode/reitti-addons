import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  RegionalShapesService,
  buildRegionalShapeIndex,
  matchRegionalShapes,
} from "../src/regional-shapes.js";

const BBOX = [13.39, 52.49, 13.43, 52.51];

function regionalZip() {
  return Buffer.from(zipSync({
    "routes.txt": strToU8([
      "route_id,route_short_name,agency_id",
      "region-route,1,region-agency",
      "outside-route,99,region-agency",
      "",
    ].join("\n")),
    "trips.txt": strToU8([
      "route_id,service_id,trip_id,trip_headsign,shape_id",
      "region-route,weekday,region-trip,Central,region-shape",
      "outside-route,weekday,outside-trip,Outside,outside-shape",
      "",
    ].join("\n")),
    "stops.txt": strToU8([
      "stop_id,stop_name,stop_lat,stop_lon",
      "RA,Start,52.50001,13.40001",
      "RB,North,52.50001,13.41000",
      "RC,End,52.50001,13.42001",
      "OUT,Outside,52.50,13.50",
      "",
    ].join("\n")),
    "stop_times.txt": strToU8([
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "region-trip,08:00:00,08:00:00,RA,1",
      "region-trip,08:10:00,08:10:00,RB,2",
      "region-trip,08:20:00,08:20:00,RC,3",
      "outside-trip,08:00:00,08:00:00,OUT,1",
      "",
    ].join("\n")),
    "shapes.txt": strToU8([
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled",
      "region-shape,52.50001,13.40001,1,0",
      "region-shape,52.51000,13.41000,2,1000",
      "region-shape,52.50001,13.42001,3,2000",
      "outside-shape,52.50,13.50,1,0",
      "outside-shape,52.50,13.51,2,1000",
      "",
    ].join("\n")),
  }));
}

function nationalIndex() {
  return {
    routes: new Map([
      ["n-route-1", { routeId: "n-route-1", shortName: "1" }],
      ["n-route-2", { routeId: "n-route-2", shortName: "2" }],
    ]),
    stops: new Map([
      ["A", { stopId: "A", lat: 52.50, lon: 13.40 }],
      ["B", { stopId: "B", lat: 52.50, lon: 13.41 }],
      ["C", { stopId: "C", lat: 52.50, lon: 13.42 }],
    ]),
    trips: new Map([
      ["national-trip", {
        tripId: "national-trip",
        routeId: "n-route-1",
        stopTimes: [{ stopId: "A" }, { stopId: "B" }, { stopId: "C" }],
      }],
      ["national-reverse", {
        tripId: "national-reverse",
        routeId: "n-route-1",
        stopTimes: [{ stopId: "C" }, { stopId: "B" }, { stopId: "A" }],
      }],
      ["national-no-route", {
        tripId: "national-no-route",
        routeId: "n-route-2",
        stopTimes: [{ stopId: "A" }, { stopId: "B" }, { stopId: "C" }],
      }],
    ]),
  };
}

test("builds a regional shapes index and filters outside-bbox data", async () => {
  const index = await buildRegionalShapeIndex(regionalZip(), { bbox: BBOX });
  assert.deepEqual([...index.trips.keys()], ["region-trip"]);
  assert.deepEqual([...index.stops.keys()].sort(), ["RA", "RB", "RC"]);
  assert.deepEqual([...index.shapes.keys()], ["region-shape"]);
  assert.equal(index.trips.get("region-trip").shapeId, "region-shape");
  assert.equal(index.shapes.get("region-shape").length, 3);
  assert.equal(index.stats.trips, 1);
});

test("matches national stop sequences to a regional trip shape", async () => {
  const regional = await buildRegionalShapeIndex(regionalZip(), { bbox: BBOX });
  const result = await matchRegionalShapes(nationalIndex(), regional, {
    regionId: "test-region",
    bbox: BBOX,
  });
  assert.equal(result.matches.size, 2);
  assert.equal(result.matches.get("national-trip").shapeId, "region-shape");
  assert.equal(result.matches.get("national-reverse").shapeId, "region-shape");
  assert.equal(result.matches.get("national-no-route"), undefined);
  assert.equal(result.matches.get("national-trip").regionId, "test-region");
  assert.equal(result.stats.consideredTrips, 3);
});

test("does not match a route with no overlapping stops", async () => {
  const regional = await buildRegionalShapeIndex(regionalZip(), { bbox: BBOX });
  const regionalRoute = [...regional.routes.values()][0];
  regionalRoute.shortName = "99";
  const result = await matchRegionalShapes(nationalIndex(), regional, {
    regionId: "test-region",
    bbox: BBOX,
  });
  assert.equal(result.matches.size, 0);
});

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function region(overrides = {}) {
  return {
    id: "test-region",
    name: "Test",
    bbox: BBOX,
    staticUrl: "https://example.com/regional.zip",
    minZoom: 9,
    priority: 1,
    maxStopDistanceMeters: 150,
    minCoverage: 0.7,
    minSimilarity: 0.6,
    cacheFile: "test-region.zip",
    enabled: true,
    ...overrides,
  };
}

test("keeps regional shapes across idle and reuses the cached match", async () => {
  let now = 1_000_000;
  let builds = 0;
  const applied = [];
  const removed = [];
  const estimated = {
    getStaticIndex: () => nationalIndex(),
    applyRegionalShapes: (regionId, matches) => {
      applied.push({ regionId, matches });
      return matches.size;
    },
    removeRegionalShapes: (regionId) => removed.push(regionId),
  };
  const service = new RegionalShapesService({
    regions: [region()],
    regionShapesMinZoom: 9,
    regionShapesIdleTimeoutMs: 10_000,
    regionShapesRefreshIntervalMs: 86_400_000,
    staticCacheDir: null,
  }, estimated, {
    now: () => now,
    logger: { info() {}, error() {} },
    downloadStatic: async () => ({ path: "regional.zip", cached: true, directory: null }),
    buildIndex: async () => {
      builds += 1;
      return buildRegionalShapeIndex(regionalZip(), { bbox: BBOX });
    },
  });
  service.start();
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  await waitFor(() => applied.length === 1);
  assert.equal(applied[0].regionId, "test-region");
  assert.equal(applied[0].matches.size, 2);
  assert.equal(service.getHealth()["test-region"].status, "ready");
  assert.equal(service.getHealth()["test-region"].matchedTrips, 2);
  assert.equal(service.getHealth()["test-region"].cached, true);

  now += 10_001;
  service.deactivateIdleRegions();
  assert.deepEqual(removed, [], "idle keeps the applied route geometry");
  assert.equal(service.getHealth()["test-region"].status, "idle");
  assert.equal(service.getHealth()["test-region"].active, false);
  assert.equal(service.getHealth()["test-region"].matchedTrips, 2);

  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  await waitFor(() => applied.length === 2);
  assert.equal(applied[1].matches, applied[0].matches, "the cached match is reused");
  assert.equal(builds, 1, "going idle and returning does not rebuild the index");
  assert.equal(service.getHealth()["test-region"].status, "ready");
  assert.equal(service.getHealth()["test-region"].matchedTrips, 2);
  service.stop();
});

test("rebuilds an idle region once the cached archive is older than the refresh interval", async () => {
  let now = 1_000_000;
  let builds = 0;
  const applied = [];
  const estimated = {
    getStaticIndex: () => nationalIndex(),
    applyRegionalShapes: (regionId, matches) => {
      applied.push({ regionId, matches });
      return matches.size;
    },
    removeRegionalShapes() {},
  };
  const service = new RegionalShapesService({
    regions: [region()],
    regionShapesMinZoom: 9,
    regionShapesIdleTimeoutMs: 10_000,
    regionShapesRefreshIntervalMs: 60_000,
    staticCacheDir: null,
  }, estimated, {
    now: () => now,
    logger: { info() {}, error() {} },
    downloadStatic: async () => ({ path: "regional.zip", cached: true, directory: null }),
    buildIndex: async () => {
      builds += 1;
      return buildRegionalShapeIndex(regionalZip(), { bbox: BBOX });
    },
  });
  service.start();
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  await waitFor(() => applied.length === 1);

  now += 10_001;
  service.deactivateIdleRegions();
  now += 60_000;
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  await waitFor(() => builds === 2);
  assert.equal(service.getHealth()["test-region"].status, "ready");
  service.stop();
});

test("does not load a region below its zoom floor or outside its bbox", async () => {
  let loads = 0;
  const service = new RegionalShapesService({
    regions: [region()],
    regionShapesMinZoom: 9,
    regionShapesIdleTimeoutMs: 10_000,
    regionShapesRefreshIntervalMs: 86_400_000,
    staticCacheDir: null,
  }, {
    getStaticIndex: () => nationalIndex(),
    applyRegionalShapes() {},
    removeRegionalShapes() {},
  }, {
    logger: { info() {}, error() {} },
    downloadStatic: async () => { loads += 1; return { path: "regional.zip", cached: true, directory: null }; },
    buildIndex: async () => buildRegionalShapeIndex(regionalZip(), { bbox: BBOX }),
  });
  service.start();
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 8);
  service.observeViewport([8, 50, 9, 51], 12);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loads, 0);
  assert.equal(service.getHealth()["test-region"].status, "idle");
  service.stop();
});

test("reports a load error and retries later", async () => {
  let now = 1_000_000;
  let attempt = 0;
  const service = new RegionalShapesService({
    regions: [region()],
    regionShapesMinZoom: 9,
    regionShapesIdleTimeoutMs: 10_000,
    regionShapesRefreshIntervalMs: 86_400_000,
    staticCacheDir: null,
  }, {
    getStaticIndex: () => nationalIndex(),
    applyRegionalShapes() {},
    removeRegionalShapes() {},
  }, {
    now: () => now,
    logger: { info() {}, error() {} },
    downloadStatic: async () => ({ path: "regional.zip", cached: true, directory: null }),
    buildIndex: async () => {
      attempt += 1;
      throw new Error("bad regional feed");
    },
  });
  service.start();
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  await waitFor(() => service.getHealth()["test-region"].status === "error");
  assert.match(service.getHealth()["test-region"].lastError, /bad regional feed/);
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  assert.equal(attempt, 1, "retries are suppressed during the cooldown");
  now += 5 * 60_000;
  service.observeViewport([13.39, 52.49, 13.43, 52.51], 9);
  await waitFor(() => attempt === 2);
  service.stop();
});
