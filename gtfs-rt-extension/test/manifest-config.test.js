import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildManifest } from "../src/manifest.js";

const required = {
  GTFS_RT_URL: "https://example.invalid/realtime",
  GTFS_STATIC_URL: "https://example.invalid/static.zip",
};

test("loads documented defaults and emits relative URLs without PUBLIC_BASE_URL", () => {
  const config = loadConfig(required);
  assert.equal(config.port, 8090);
  assert.deepEqual(config.bbox, [10.55, 53.78, 10.92, 53.99]);
  assert.equal(config.staleAfterSeconds, 180);
  assert.equal(config.refreshIntervalMs, 15_000);
  assert.equal(config.estimatedPositionRefreshIntervalMs, 15_000);
  assert.equal(config.liveCityMinZoom, 10);
  assert.equal(config.liveCityIdleTimeoutMs, 600_000);
  assert.equal(config.staticRefreshIntervalMs, 21_600_000);
  assert.equal(config.staticCacheDir, null);

  const manifest = buildManifest(config);
  const layer = manifest.layers[0];
  assert.equal(manifest.$schema, "https://reitti.dev/schemas/extension-manifest.v1.json");
  assert.equal(manifest.icon, "/assets/bus.svg");
  assert.equal(layer.endpoint, "/vehicles");
  assert.equal(layer.assets.iconUrl, "/assets/bus.svg");
  assert.equal(layer.assets.scale, 4);
  assert.equal(layer.assets.models.bus.modelUrl, "/assets/bus.glb");
  assert.equal(layer.assets.models.tram.modelUrl, "/assets/tram.glb");
  assert.equal(layer.assets.models.train.modelUrl, "/assets/train.glb");
  assert.equal(layer.assets.models.subway.modelUrl, "/assets/subway.glb");
  assert.equal(layer.assets.models.sbahn.modelUrl, "/assets/train.glb");
  assert.equal(layer.assets.models.ice.modelUrl, "/assets/high-speed.glb");
  assert.equal(layer.assets.models.ice.minZoom, 5);
  assert.equal(layer.assets.models.ice.maxZoomScale, 192);
  assert.equal(layer.mapping.modelField, "model");
  assert.deepEqual(layer.mapping.previousCoordinateField, ["previousLon", "previousLat"]);
  assert.equal(layer.mapping.previousHeadingField, "previousBearing");
  assert.equal(layer.mapping.previousTimestampField, "previousUpdatedAt");
  assert.equal(layer.staleAfterMs, 180_000);
  assert.equal(layer.pollIntervalMs, 15_000);
  assert.equal(layer.placement, "behind-buildings");
  assert.equal(layer.zIndex, 0);
  assert.deepEqual(layer.mapping.coordinateField, ["lon", "lat"]);
  assert.equal(buildManifest(loadConfig({ ...required, STALE_AFTER_SECONDS: "300" })).layers[0].staleAfterMs, 300_000);
  const estimated = buildManifest(loadConfig({ ...required, FEED_TYPE: "gtfs-rt-estimated" }));
  assert.equal(estimated.id, "germany-transit");
  assert.equal(estimated.layers[0].id, "germany-estimated-transit");
  assert.equal(estimated.layers[0].mapping.labelField, "displayText");
  const liveBerlin = buildManifest(loadConfig({ FEED_TYPE: "transport-rest" }));
  assert.equal(liveBerlin.id, "berlin-transit");
  assert.equal(liveBerlin.layers[0].id, "berlin-live-transit");
  assert.equal(liveBerlin.layers[0].endpoint, "/vehicles");
  const unified = buildManifest(loadConfig({
    FEED_TYPE: "germany",
    GTFS_RT_URL: "https://example.invalid/realtime",
    GTFS_STATIC_URL: "https://example.invalid/static.zip",
  }));
  assert.equal(unified.name, "Germany Transit");
  assert.equal(unified.layers.length, 2);
  assert.equal(unified.layers[0].id, "germany-transit");
  assert.equal(unified.layers[0].endpoint, "/vehicles");
  assert.equal(unified.layers[0].minZoom, 5);
  assert.equal(unified.layers[0].assets.models.bus.minZoom, 10);
  assert.equal(unified.layers[0].assets.models.bus.zoomScaleExponent, 0.8);
  assert.equal(unified.layers[0].assets.models.ice.labelMinZoom, 5);
  assert.equal(unified.layers[0].assets.models.ice.zoomScaleExponent, 0.8);
  assert.equal(unified.layers[0].assets.models.ic.labelMinZoom, 5);
  assert.equal(unified.layers[0].assets.models.ic.zoomScaleExponent, 0.8);
  assert.equal(unified.layers[0].assets.models.bus.labelMinZoom, undefined);
  assert.equal(unified.layers[0].assets.labelOffsetY, 12);
  assert.equal(unified.layers[0].mapping.colorField, undefined);
  assert.equal(unified.layers[0].assets.models.ice.modelUrl, "/assets/high-speed.glb");
  assert.equal(unified.layers[1].id, "germany-transit-colored");
  assert.equal(unified.layers[1].name, "Buses, trams and trains (line colours)");
  assert.equal(unified.layers[1].mapping.colorField, "lineColor");

  const colored = buildManifest(loadConfig({
    FEED_TYPE: "germany",
    GTFS_RT_URL: "https://example.invalid/realtime",
    GTFS_STATIC_URL: "https://example.invalid/static.zip",
  }), "colored");
  assert.equal(colored.id, "germany-transit-colored");
  assert.equal(colored.name, "Germany Transit Colors");
  assert.equal(colored.layers[0].id, "germany-transit-colored");
  assert.equal(colored.layers[0].mapping.colorField, "lineColor");
  assert.equal(colored.layers[0].assets.models.bus.modelUrl, "/assets/bus-colored.glb");

  const cached = loadConfig({
    ...required,
    STATIC_CACHE_DIR: "/tmp/reitti-static-cache",
  });
  assert.equal(cached.staticCacheDir, "/tmp/reitti-static-cache");
  const estimatedConfig = loadConfig({ ...required, FEED_TYPE: "gtfs-rt-estimated" });
  assert.equal(estimatedConfig.staticRefreshIntervalMs, 300_000);
  assert.equal(loadConfig(required).staticRefreshIntervalMs, 21_600_000);
});

test("validates required URLs, ports and bounding boxes", () => {
  assert.throws(() => loadConfig({}), /GTFS_RT_URL is required/);
  assert.throws(() => loadConfig({ ...required, PORT: "0" }), /PORT/);
  assert.throws(() => loadConfig({ ...required, BBOX: "11,53,10,54" }), /BBOX/);
  assert.throws(() => loadConfig({ ...required, STALE_AFTER_SECONDS: "0" }), /STALE_AFTER_SECONDS/);
  assert.throws(() => loadConfig({ ...required, STALE_AFTER_SECONDS: "86401" }), /STALE_AFTER_SECONDS/);
});
