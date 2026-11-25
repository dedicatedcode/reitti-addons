import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { OverlayStore } from "../src/overlays/store.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Road" },
      geometry: { type: "LineString", coordinates: [[13.4, 52.5], [13.5, 52.6]] },
    },
    {
      type: "Feature",
      properties: { name: "Zone" },
      geometry: {
        type: "Polygon",
        coordinates: [[[13.4, 52.5], [13.5, 52.5], [13.5, 52.6], [13.4, 52.5]]],
      },
    },
    {
      type: "Feature",
      properties: { name: "Far away" },
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    },
  ],
});

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "overlay-http-"));
  const config = loadConfig({
    DATA_DIR: dir,
    DEFAULT_TIMEZONE: "Europe/Berlin",
    MAX_UPLOAD_BYTES: String(1024 * 1024),
  });
  const store = new OverlayStore(config);
  await store.load();
  const server = createServer(createApp({ config, store, logger }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    dir,
    config,
    store,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function json(base, path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

async function createOverlay(base, overrides = {}) {
  return json(base, "/api/overlays", {
    method: "POST",
    body: JSON.stringify({
      name: "Event map",
      filename: "event.geojson",
      format: "geojson",
      content: GEOJSON,
      timezone: "Europe/Berlin",
      validity: {
        mode: "range",
        timezone: "Europe/Berlin",
        startDate: "2020-01-01",
        startTime: "00:00",
        endDate: "2020-01-02",
        endTime: "23:59",
      },
      style: { color: "#ff5500", lineWidth: 4, lineAlpha: 200 },
      ...overrides,
    }),
  });
}

test("serves the manifest and empty data", async () => {
  const server = await startServer();
  try {
    const manifest = await json(server.base, "/reitti-extension.json");
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type"), /application\/json/);
    assert.equal(manifest.body.layers.length, 1);
    assert.equal(manifest.body.layers[0].id, "overlays");

    const data = await json(server.base, "/overlays.geojson");
    assert.equal(data.status, 200);
    assert.match(data.headers.get("content-type"), /application\/geo\+json/);
    assert.equal(data.headers.get("cache-control"), "no-store");
    assert.deepEqual(data.body, { type: "FeatureCollection", features: [] });

    const health = await json(server.base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");

    const config = await json(server.base, "/api/config");
    assert.equal(config.status, 200);
    assert.equal(config.body.registrationUrl, server.base);
    assert.equal(config.body.manifestUrl, undefined);
    assert.equal(config.body.manifestPath, undefined);
  } finally {
    await server.close();
  }
});

test("creates overlays and filters by date and bbox", async () => {
  const server = await startServer();
  try {
    const created = await createOverlay(server.base);
    assert.equal(created.status, 201);
    assert.equal(created.body.id, "event-map");
    assert.equal(created.body.stats.pathFeatures, 2);
    assert.equal(created.body.stats.areaFeatures, 1);

    const list = await json(server.base, "/api/overlays");
    assert.equal(list.body.overlays.length, 1);
    assert.ok(list.body.totalBytes > 0);

    const onDate = await json(server.base, "/overlays.geojson?date=2020-01-01");
    assert.equal(onDate.body.features.length, 3);
    const line = onDate.body.features.find((feature) => feature.geometry.type === "LineString" && feature.properties.name === "Road");
    assert.deepEqual(line.properties.lineColor, [255, 85, 0, 200]);
    assert.equal(line.properties.lineWidth, 4);

    const outsideDate = await json(server.base, "/overlays.geojson?date=2020-01-03");
    assert.deepEqual(outsideDate.body.features, []);

    const inside = await json(server.base, "/overlays.geojson?date=2020-01-01&bbox=13.35,52.45,13.55,52.65");
    assert.equal(inside.body.features.length, 2);
    assert.ok(inside.body.features.every((feature) => !feature.properties.name || feature.properties.name !== "Far away"));

    const outside = await json(server.base, "/overlays.geojson?date=2020-01-01&bbox=0,0,1,1");
    assert.equal(outside.body.features.length, 1);
    assert.equal(outside.body.features[0].properties.name, "Far away");

    const preview = await json(server.base, "/api/preview.geojson");
    assert.equal(preview.body.features.length, 3);
    assert.ok(preview.body.features.some((feature) => feature.properties.kind === "area"));
    assert.ok(preview.body.features.every((feature) => feature.properties.overlayId === "event-map"));

    const exported = await fetch(`${server.base}/api/overlays/event-map/export.geojson`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /event-map\.geojson/);
    const exportedBody = await exported.json();
    assert.equal(exportedBody.features.length, 3);
    assert.equal(exportedBody.features[0].properties.lineColor, "#ff5500");
  } finally {
    await server.close();
  }
});

test("updates metadata, validity and enabled state", async () => {
  const server = await startServer();
  try {
    await createOverlay(server.base);

    const updated = await json(server.base, "/api/overlays/event-map", {
      method: "PUT",
      body: JSON.stringify({
        name: "Renamed",
        enabled: false,
        style: { color: "#00ff00", lineWidth: 6 },
        validity: {
          mode: "daily",
          timezone: "Europe/Berlin",
          dailyStart: "18:00",
          dailyEnd: "23:00",
        },
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "Renamed");
    assert.equal(updated.body.enabled, false);
    assert.equal(updated.body.style.color, "#00ff00");
    assert.equal(updated.body.validity.mode, "daily");

    const data = await json(server.base, "/overlays.geojson");
    assert.deepEqual(data.body.features, []);

    await json(server.base, "/api/overlays/event-map", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        validity: { mode: "always", timezone: "Europe/Berlin" },
      }),
    });
    const enabled = await json(server.base, "/overlays.geojson");
    assert.ok(enabled.body.features.length > 0);
  } finally {
    await server.close();
  }
});

test("rejects invalid requests", async () => {
  const server = await startServer();
  try {
    const badBbox = await json(server.base, "/overlays.geojson?bbox=1,2,3");
    assert.equal(badBbox.status, 400);
    assert.match(badBbox.body.error, /bbox/);

    const badDate = await json(server.base, "/overlays.geojson?date=01.01.2020");
    assert.equal(badDate.status, 400);

    const badJson = await fetch(`${server.base}/api/overlays`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(badJson.status, 400);

    const badType = await fetch(`${server.base}/api/overlays`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({}),
    });
    assert.equal(badType.status, 415);

    const badGeometry = await json(server.base, "/api/overlays", {
      method: "POST",
      body: JSON.stringify({ name: "Bad", filename: "bad.geojson", content: "{}" }),
    });
    assert.equal(badGeometry.status, 400);
    assert.match(badGeometry.body.error, /no usable/);

    const missing = await json(server.base, "/api/overlays/nope", { method: "DELETE" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /does not exist/);

    const unknown = await json(server.base, "/api/nope");
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test("replaces geometry and deletes overlays", async () => {
  const server = await startServer();
  try {
    await createOverlay(server.base);
    const replaced = await json(server.base, "/api/overlays/event-map/geometry", {
      method: "POST",
      body: JSON.stringify({
        filename: "route.gpx",
        format: "gpx",
        content: `<gpx><trk><name>New</name><trkseg>
          <trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/>
        </trkseg></trk></gpx>`,
      }),
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.source.format, "gpx");
    assert.equal(replaced.body.stats.pathFeatures, 1);
    assert.equal(replaced.body.stats.areaFeatures, 0);

    const removed = await fetch(`${server.base}/api/overlays/event-map`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    const list = await json(server.base, "/api/overlays");
    assert.deepEqual(list.body.overlays, []);
  } finally {
    await server.close();
  }
});

test("serves the UI and health", async () => {
  const server = await startServer();
  try {
    const index = await fetch(`${server.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);

    const icon = await fetch(`${server.base}/assets/icon.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /image\/svg\+xml/);

    const traversal = await fetch(`${server.base}/../package.json`);
    assert.ok([400, 404].includes(traversal.status));
  } finally {
    await server.close();
  }
});
