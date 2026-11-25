import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { FeedService } from "../src/feed-service.js";
import { createHttpServer } from "../src/http-server.js";
import {
  NOW_MS,
  baseEnvironment,
  close,
  feedBuffer,
  listen,
  staticZip,
  vehicleEntity,
} from "./helpers.js";

test("serves cached normalized data, manifest, assets, health and Bearer auth", async (t) => {
  let realtimeRequests = 0;
  let staticRequests = 0;
  let failRealtime = false;
  const realtime = feedBuffer({
    entities: [vehicleEntity("bus-1", {
      timestamp: 990,
      bearing: 270,
      speed: 5,
    })],
  });
  const archive = staticZip();
  const upstream = createServer((request, response) => {
    if (request.url === "/realtime") {
      realtimeRequests += 1;
      if (failRealtime) {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/x-protobuf" }).end(realtime);
    } else if (request.url === "/static.zip") {
      staticRequests += 1;
      response.writeHead(200, { "content-type": "application/zip" }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  const upstreamUrl = await listen(upstream);
  const config = loadConfig({
    ...baseEnvironment(upstreamUrl),
    PUBLIC_BASE_URL: "https://extensions.example.test/gtfs/",
    EXTENSION_API_KEY: "test-secret",
  });
  const service = new FeedService(config, {
    now: () => NOW_MS,
    logger: { error() {} },
  });
  await service.refreshAll();
  const server = createHttpServer(config, service, { logger: { error() {} } });
  const serviceUrl = await listen(server);
  t.after(async () => {
    service.stop();
    await close(server);
    await close(upstream);
  });

  for (const path of ["/reitti-extension.json", "/vehicles"]) {
    const unauthorized = await fetch(`${serviceUrl}${path}`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate"), /Bearer/);
  }

  const auth = { authorization: "Bearer test-secret" };
  const manifestResponse = await fetch(`${serviceUrl}/reitti-extension.json`, { headers: auth });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.id, "luebeck-transit");
  assert.equal(manifest.layers.length, 1);
  assert.equal(manifest.layers[0].mapping.idField, "vehicleId");
  assert.deepEqual(manifest.layers[0].mapping.coordinateField, ["lon", "lat"]);
  assert.equal(manifest.layers[0].mapping.headingField, "bearing");
  assert.equal(manifest.layers[0].mapping.labelField, undefined);
  assert.equal(manifest.layers[0].mapping.modelField, "model");
  assert.equal(manifest.layers[0].mapping.details.rows.length, 3);
  assert.equal(manifest.layers[0].id, "luebeck-live-buses");
  assert.equal(manifest.layers[0].type, "polling");
  assert.equal(manifest.layers[0].protocol, "http");
  assert.equal(manifest.layers[0].endpoint, "https://extensions.example.test/gtfs/vehicles");
  assert.equal(manifest.icon, "https://extensions.example.test/gtfs/assets/bus.svg");
  assert.equal(manifest.layers[0].assets.iconUrl, "https://extensions.example.test/gtfs/assets/bus.svg");
  assert.equal(manifest.layers[0].renderer, "ScenegraphLayer");
  assert.equal(manifest.layers[0].assets.modelUrl, "https://extensions.example.test/gtfs/assets/bus.glb");
  assert.equal(manifest.layers[0].format, "json");
  assert.equal(manifest.layers[0].dataPath, "vehicles");
  assert.equal(manifest.layers[0].pollIntervalMs, 15_000);
  assert.equal(manifest.layers[0].pollTrigger, "both");
  assert.equal(manifest.layers[0].minZoom, 10);

  for (let request = 0; request < 3; request += 1) {
    const dataResponse = await fetch(`${serviceUrl}/vehicles`, { headers: auth });
    assert.equal(dataResponse.status, 200);
    const payload = await dataResponse.json();
    assert.deepEqual(Object.keys(payload), ["timestamp", "vehicles"]);
    assert.deepEqual(Object.keys(payload.vehicles[0]), [
      "vehicleId",
      "tripId",
      "routeId",
      "line",
      "lineColor",
      "labelColor",
      "headsign",
      "lon",
      "lat",
      "bearing",
      "speedKmh",
      "updatedAt",
      "positionSource",
      "displayText",
      "vehicleType",
      "model",
    ]);
    assert.equal(payload.vehicles[0].line, "1");
    assert.equal(payload.vehicles[0].headsign, "Hauptbahnhof, Zentrum");
    assert.equal(payload.vehicles[0].speedKmh, 18);
  }
  assert.equal(realtimeRequests, 1, "data requests must use the cached snapshot");
  assert.equal(staticRequests, 1);

  const viewport = await fetch(`${serviceUrl}/vehicles?bbox=10.69,53.85,10.71,53.87&zoom=14`, { headers: auth });
  assert.equal(viewport.status, 200);
  assert.equal((await viewport.json()).vehicles.length, 1);
  const belowMinZoom = await fetch(`${serviceUrl}/vehicles?zoom=9`, { headers: auth });
  assert.equal((await belowMinZoom.json()).vehicles.length, 0);
  const invalidViewport = await fetch(`${serviceUrl}/vehicles?bbox=invalid`, { headers: auth });
  assert.equal(invalidViewport.status, 400);
  const notToday = await fetch(`${serviceUrl}/vehicles?date=2020-01-01`, { headers: auth });
  assert.equal(notToday.status, 200);
  assert.deepEqual((await notToday.json()).vehicles, []);
  assert.equal(realtimeRequests, 1, "viewport filtering must not trigger upstream requests");

  const icon = await fetch(`${serviceUrl}/assets/bus.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await icon.text(), /<svg/);
  const model = await fetch(`${serviceUrl}/assets/bus.glb`);
  assert.equal(model.status, 200);
  assert.match(model.headers.get("content-type"), /model\/gltf-binary/);
  const modelBytes = new Uint8Array(await model.arrayBuffer());
  assert.deepEqual(Array.from(modelBytes.slice(0, 4)), Array.from(new TextEncoder().encode("glTF")));
  const trainModel = await fetch(`${serviceUrl}/assets/train.glb`);
  assert.equal(trainModel.status, 200);
  assert.equal(manifest.layers[0].assets.models.train.modelUrl, "https://extensions.example.test/gtfs/assets/train.glb");
  for (const name of [
    "tram", "subway", "high-speed", "sbahn", "ic", "ice",
    "bus-colored", "tram-colored", "train-colored", "subway-colored", "high-speed-colored",
  ]) {
    const response = await fetch(`${serviceUrl}/assets/${name}.glb`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /model\/gltf-binary/);
  }
  const attribution = await fetch(`${serviceUrl}/assets/ATTRIBUTION.txt`);
  assert.equal(attribution.status, 200);
  assert.match(attribution.headers.get("content-type"), /text\/plain/);
  assert.match(await attribution.text(), /Grab3D/);

  const healthResponse = await fetch(`${serviceUrl}/health`);
  assert.equal(healthResponse.status, 200, "health does not require Bearer auth");
  assert.equal((await healthResponse.json()).status, "ok");

  failRealtime = true;
  assert.equal(await service.refreshRealtime(), false);
  const cachedResponse = await fetch(`${serviceUrl}/vehicles`, { headers: auth });
  assert.equal(cachedResponse.status, 200);
  assert.equal((await cachedResponse.json()).vehicles[0].vehicleId, "bus-1");
  const degradedResponse = await fetch(`${serviceUrl}/health`);
  assert.equal(degradedResponse.status, 503);
  assert.equal((await degradedResponse.json()).status, "degraded");
  assert.equal(realtimeRequests, 2);
});

test("unified extension keeps vehicles available below the standard zoom floor", async (t) => {
  const config = loadConfig({
    FEED_TYPE: "germany",
    GTFS_RT_URL: "https://fixtures.invalid/realtime",
    GTFS_STATIC_URL: "https://fixtures.invalid/static.zip",
    BBOX: "13.20,52.35,13.65,52.65",
  });
  let observed = null;
  const service = {
    getSnapshot: () => ({
      timestamp: new Date(NOW_MS).toISOString(),
      vehicles: [
        { vehicleId: "bus-1", lon: 13.4, lat: 52.5, model: "bus", bearing: 0 },
        { vehicleId: "ice-1", lon: 13.4, lat: 52.5, model: "ice", bearing: 0 },
      ],
    }),
    getHealth: () => ({ status: "ok" }),
    observeViewport: (bbox, zoom) => { observed = { bbox, zoom }; },
  };
  const server = createHttpServer(config, service, { logger: { error() {} } });
  const serviceUrl = await listen(server);
  t.after(() => close(server));

  const lowZoom = await fetch(`${serviceUrl}/vehicles?zoom=8&bbox=13.2,52.35,13.65,52.65`);
  assert.deepEqual(observed, { bbox: [13.2, 52.35, 13.65, 52.65], zoom: 8 });
  assert.equal(lowZoom.status, 200);
  assert.deepEqual((await lowZoom.json()).vehicles.map(vehicle => vehicle.vehicleId), ["ice-1"]);

  const cityZoom = await fetch(`${serviceUrl}/vehicles?zoom=10&bbox=13.2,52.35,13.65,52.65`);
  assert.equal(cityZoom.status, 200);
  assert.equal((await cityZoom.json()).vehicles.length, 2);
});
