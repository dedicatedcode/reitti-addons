import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { buildManifest } from "../src/overlays/manifest.js";
import { publicFeature } from "../src/overlays/model.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PLACEMENTS = new Set(["behind-buildings", "above-buildings", "below-paths", "top"]);
const RENDERERS = new Set(["PathLayer", "PolygonLayer", "IconLayer", "BitmapLayer", "ScenegraphLayer"]);
const FORMATS = new Set(["json", "geojson", "gpx", "image"]);

function defaultConfig(overrides = {}) {
  return loadConfig({ DEFAULT_TIMEZONE: "Europe/Berlin", ...overrides });
}

test("builds a stable single-layer manifest", () => {
  const config = defaultConfig();
  const first = buildManifest(config);
  const second = buildManifest(config);
  assert.deepEqual(first, second);
  assert.equal(first.layers.length, 1);

  const layer = first.layers[0];
  assert.equal(first.id, "reitti-overlays");
  assert.equal(layer.id, "overlays");
  assert.equal(layer.type, "polling");
  assert.equal(layer.protocol, "http");
  assert.equal(layer.renderer, "PathLayer");
  assert.equal(layer.format, "geojson");
  assert.equal(layer.pollTrigger, "both");
  assert.equal(layer.placement, "below-paths");
  assert.equal(layer.endpoint, "overlays.geojson");
  assert.equal(first.icon, "assets/icon.svg");
  assert.deepEqual(layer.assets.lineColor, [217, 164, 65, 220]);
  assert.equal(layer.assets.lineWidth, 3);
});

test("uses absolute URLs when PUBLIC_BASE_URL is set", () => {
  const manifest = buildManifest(defaultConfig({ PUBLIC_BASE_URL: "https://maps.example.com/reitti" }));
  assert.equal(manifest.icon, "https://maps.example.com/reitti/assets/icon.svg");
  assert.equal(manifest.layers[0].endpoint, "https://maps.example.com/reitti/overlays.geojson");
});

test("produces a manifest that satisfies the Reitti contract", () => {
  const manifest = buildManifest(defaultConfig());
  const base = new URL("http://overlay-extension:8090/reitti-extension.json");

  assert.ok(ID.test(manifest.id));
  assert.ok(manifest.name.length > 0 && manifest.name.length <= 256);
  assert.ok(manifest.version.length > 0 && manifest.version.length <= 64);
  assert.ok((manifest.description || "").length <= 1000);
  assert.ok(manifest.layers.length <= 50);

  const resolve = (value) => {
    const url = new URL(value, base);
    assert.ok(["http:", "https:"].includes(url.protocol));
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.hash, "");
    return url;
  };

  resolve(manifest.icon);
  for (const layer of manifest.layers) {
    assert.ok(ID.test(layer.id));
    assert.ok((layer.name || "").length <= 256);
    assert.ok((layer.description || "").length <= 1000);
    assert.ok(["static", "polling", "streaming"].includes(layer.type));
    assert.ok(["http", "websocket", "sse"].includes(layer.protocol));
    assert.ok(RENDERERS.has(layer.renderer));
    assert.ok(FORMATS.has(layer.format));
    assert.ok(PLACEMENTS.has(layer.placement));
    assert.ok(Number.isInteger(layer.zIndex) && layer.zIndex >= -10000 && layer.zIndex <= 10000);
    assert.ok(Number.isInteger(layer.pollIntervalMs) && layer.pollIntervalMs >= 1000 && layer.pollIntervalMs <= 86_400_000);
    assert.ok(Number.isInteger(layer.minZoom) && layer.minZoom >= 0 && layer.minZoom <= 30);
    resolve(layer.endpoint);

    if (layer.renderer === "PathLayer" || layer.renderer === "PolygonLayer") {
      assert.ok(["geojson", "json", "gpx"].includes(layer.format));
    }
    const color = layer.assets.lineColor;
    assert.ok(Array.isArray(color) && (color.length === 3 || color.length === 4));
    assert.ok(color.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
  }
});

test("emits per-feature colour and width", () => {
  const feature = publicFeature(
    {
      type: "Feature",
      properties: { name: "Road" },
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    },
    { style: { color: "#ff5500", lineWidth: 4, lineAlpha: 200 } },
  );
  assert.deepEqual(feature.properties, {
    name: "Road",
    lineColor: [255, 85, 0, 200],
    lineWidth: 4,
  });
  assert.equal(feature.geometry.type, "LineString");
});

test("rejects invalid configuration", () => {
  assert.throws(() => defaultConfig({ EXTENSION_ID: "!bad" }), /EXTENSION_ID/);
  assert.throws(() => defaultConfig({ POLL_INTERVAL_MS: "10" }), /POLL_INTERVAL_MS/);
  assert.throws(() => defaultConfig({ PLACEMENT: "somewhere" }), /PLACEMENT/);
  assert.throws(() => defaultConfig({ DEFAULT_TIMEZONE: "Mars/Olympus" }), /time zone/);
  assert.throws(() => defaultConfig({ LINE_COLOR: "gold" }), /LINE_COLOR/);
});
